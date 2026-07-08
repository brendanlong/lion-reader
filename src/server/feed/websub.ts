/**
 * WebSub utility functions.
 * Provides helpers for WebSub (PubSubHubbub) support including:
 * - Checking if WebSub can be used (requires public URL)
 * - Generating callback URLs and secrets
 * - Subscribing to WebSub hubs
 * - Verifying HMAC signatures on content notifications
 */

import { randomBytes, createHmac, timingSafeEqual } from "crypto";
import { eq, and, lt, desc } from "drizzle-orm";
import { fetchWithSsrfProtection } from "../http/ssrf";
import { readResponseBufferWithSizeLimit } from "../http/fetch";
import { db } from "../db";
import { feeds, websubSubscriptions, type Feed, type WebsubSubscription } from "../db/schema";
import { generateUuidv7 } from "../../lib/uuidv7";
import { logger } from "@/lib/logger";

/**
 * Timeout for hub subscription POST requests (10 seconds).
 * These are awaited inside the fetch job and renewal loop, so a wedged hub
 * must not stall them indefinitely.
 */
const HUB_REQUEST_TIMEOUT_MS = 10000;

/**
 * Default lease length (seconds) assumed when a hub verifies a subscription
 * without sending `hub.lease_seconds`.
 *
 * The spec says hubs SHOULD send it, but some don't. Storing `expiresAt = null`
 * would leave the subscription outside the `expiresAt < threshold` renewal
 * filter forever, so we'd keep it "active" in our DB even after the hub silently
 * dropped it. Stamping a concrete expiry means the renewal job re-verifies it on
 * schedule and, if the hub has dropped us, marks it failed so polling takes over.
 * One day matches our backup-poll cadence.
 */
const DEFAULT_LEASE_SECONDS = 24 * 60 * 60;

/**
 * Maximum lease length (seconds) we honor from a hub: 14 days.
 *
 * We store `expiresAt = now + lease_seconds` and only re-verify a subscription
 * when it nears expiry, so a hub granting a very long lease means we'd trust the
 * subscription — and never re-confirm the hub is still delivering — for that
 * whole period. A hub can silently stop pushing while still "active" in our DB,
 * so we cap how long that can last by clamping the honored lease.
 *
 * We don't request a shorter lease from the hub (WebSub has no such request); we
 * just renew earlier than the hub's stated expiry. 14 days sits comfortably above
 * the common ~10-day hub max, so it rarely fires against well-behaved hubs; it
 * only bounds our worst-case re-verification cadence.
 */
export const MAX_LEASE_SECONDS = 14 * 24 * 60 * 60;

/**
 * How long past its lease expiry a subscription may stay unrenewed before the
 * sweep gives up and reverts the feed to polling (6 hours).
 *
 * A renewal keeps the subscription `active` and retries the hub POST on each
 * renewal sweep (hourly) until the hub's verification GET lands (advancing
 * `expiresAt` back into the future). If the hub accepts the (re)subscribe but
 * never verifies — a deploy restart dropping the callback, a chronically broken
 * hub — `expiresAt` stays fixed in the past and the subscription would otherwise
 * retry forever while silently push-dead. Once it is this far past `expiresAt`
 * we mark it failed so the feed reverts to polling; the next fetch then
 * resubscribes cleanly (a fresh subscription that flips `websubActive` only on
 * verification). Six hours gives several sweep retries to absorb a transient
 * outage before we fall back. Measuring from `expiresAt` (rather than a separate
 * "renewal started" timestamp) means a verification that races the sweep — or an
 * old release that renews without our bookkeeping — self-corrects: it advances
 * `expiresAt`, which removes the row from the stale window with no extra state.
 */
export const RENEWAL_STALL_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * `lastError` / renewal-result message stamped when a subscription is reverted to
 * polling for stalling past `RENEWAL_STALL_GRACE_MS`. Shared so the sweep's result
 * entry and the row's stored error can't drift apart.
 */
const RENEWAL_STALL_ERROR = "Renewal not verified by hub within grace period";

/**
 * Private/local hostnames and IP ranges that can't receive WebSub callbacks.
 */
const PRIVATE_HOSTNAMES = ["localhost", "127.0.0.1", "0.0.0.0", "::1"];

/**
 * Private IP address prefixes (RFC 1918 and RFC 4193).
 */
const PRIVATE_IP_PREFIXES = [
  "10.",
  "172.16.",
  "172.17.",
  "172.18.",
  "172.19.",
  "172.20.",
  "172.21.",
  "172.22.",
  "172.23.",
  "172.24.",
  "172.25.",
  "172.26.",
  "172.27.",
  "172.28.",
  "172.29.",
  "172.30.",
  "172.31.",
  "192.168.",
];

/**
 * Checks if a hostname is private (local or internal network).
 *
 * @param hostname - The hostname to check
 * @returns true if the hostname is private
 */
function isPrivateHostname(hostname: string): boolean {
  // Check exact matches for localhost variants
  if (PRIVATE_HOSTNAMES.includes(hostname.toLowerCase())) {
    return true;
  }

  // Check for private IP prefixes
  for (const prefix of PRIVATE_IP_PREFIXES) {
    if (hostname.startsWith(prefix)) {
      return true;
    }
  }

  // Check for .local domain suffix (mDNS)
  if (hostname.toLowerCase().endsWith(".local")) {
    return true;
  }

  return false;
}

/**
 * Checks if WebSub can be used for receiving push notifications.
 *
 * WebSub requires a publicly accessible callback URL that the hub can reach.
 * This function checks if the application is configured with a public URL.
 *
 * @returns true if WebSub can be used, false otherwise
 *
 * @example
 * if (feed.hubUrl && canUseWebSub()) {
 *   await subscribeToHub(feed);
 * } else {
 *   // Fall back to polling
 *   await scheduleNextFetch(feed);
 * }
 */
export function canUseWebSub(): boolean {
  // Allow explicit disable via environment variable
  if (process.env.WEBSUB_ENABLED === "false") {
    return false;
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;

  // WebSub requires a configured base URL
  if (!baseUrl) {
    return false;
  }

  try {
    const url = new URL(baseUrl);

    // Don't attempt WebSub for private/local hostnames
    if (isPrivateHostname(url.hostname)) {
      return false;
    }

    // Must be HTTPS in production (hubs may reject HTTP callbacks)
    // Allow HTTP for development/testing scenarios
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
      return false;
    }

    return true;
  } catch {
    // Invalid URL
    return false;
  }
}

/**
 * The action a feed fetch should take on the feed's WebSub subscription, based
 * on how the feed's advertised hub URL changed since the last fetch.
 *
 * - `subscribe` - feed advertises a hub and we're not subscribed yet
 * - `resubscribe` - feed advertises a *different* hub than the one we're
 *   subscribed to (publisher switched hubs); tear down the old subscription and
 *   subscribe to the new hub
 * - `deactivate` - feed no longer advertises a hub; drop back to polling
 * - `none` - nothing to do (no hub, WebSub unavailable, or already subscribed to
 *   the same hub — lease renewal is handled separately)
 */
export type WebsubAction = "subscribe" | "resubscribe" | "deactivate" | "none";

/**
 * Decides what to do with a feed's WebSub subscription given the hub URL seen in
 * the latest fetch versus the previously stored state. Pure function so the
 * decision can be unit-tested without a DB or HTTP.
 *
 * The `resubscribe` case is the one that keeps a publisher's hub switch from
 * silently breaking push: without it, a feed that changes its `rel="hub"` while
 * `websubActive` is already true would keep a dangling subscription pointed at
 * the old (often dead) hub and never subscribe to the new one until the lease
 * happened to expire.
 */
export function resolveWebsubAction(params: {
  /** Hub URL stored on the feed before this fetch. */
  previousHubUrl: string | null;
  /** Whether the feed was already actively subscribed via WebSub. */
  previousWebsubActive: boolean;
  /** Hub URL advertised in the current fetch (null if none). */
  newHubUrl: string | null;
  /** Whether WebSub is usable at all (public callback URL configured). */
  canUseWebSub: boolean;
}): WebsubAction {
  const { previousHubUrl, previousWebsubActive, newHubUrl, canUseWebSub } = params;

  // Feed advertises no hub - tear down any active subscription, else nothing.
  if (!newHubUrl) {
    return previousWebsubActive ? "deactivate" : "none";
  }

  // Feed has a hub but we can't receive callbacks - stay on polling.
  if (!canUseWebSub) {
    return "none";
  }

  // Not subscribed yet - subscribe fresh.
  if (!previousWebsubActive) {
    return "subscribe";
  }

  // Already active: only act if the publisher switched to a different hub.
  return previousHubUrl !== newHubUrl ? "resubscribe" : "none";
}

/**
 * Gets the base URL for WebSub callbacks.
 * Returns the configured NEXT_PUBLIC_APP_URL or null if not available.
 *
 * @returns The base URL string or null
 */
function getWebsubCallbackBaseUrl(): string | null {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!baseUrl || !canUseWebSub()) {
    return null;
  }
  // Remove trailing slash if present
  return baseUrl.replace(/\/$/, "");
}

/**
 * Generates a WebSub callback URL for a specific feed.
 *
 * The subscription ID is part of the path so a hub's verification/notification
 * callbacks map to exactly one subscription row. Without it (the old per-feed
 * URL), a feed that switched hubs — leaving an old and a new subscription row —
 * produced callbacks that were ambiguous by feed alone.
 *
 * @param feedId - The feed ID
 * @param subscriptionId - The WebSub subscription ID
 * @returns The callback URL or null if WebSub is not available
 */
function generateCallbackUrl(feedId: string, subscriptionId: string): string | null {
  const baseUrl = getWebsubCallbackBaseUrl();
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl}/api/webhooks/websub/${feedId}/${subscriptionId}`;
}

/**
 * Generates a random secret for HMAC signature verification.
 *
 * @returns A 32-byte hex-encoded secret string
 */
export function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Result of a subscription request to a hub.
 */
export interface SubscribeToHubResult {
  /** Whether the subscription request was accepted by the hub */
  success: boolean;
  /** The subscription record ID if successful */
  subscriptionId?: string;
  /** Error message if the request failed */
  error?: string;
}

/**
 * Subscribes to a WebSub hub for a feed.
 *
 * Creates a pending subscription record and sends a subscription request
 * to the hub. The hub will then send a verification callback (GET request)
 * to confirm the subscription.
 *
 * **Renewal is non-disruptive.** When an existing row for this feed+hub is
 * already `active`, this is a lease renewal: the row stays `active` under its
 * existing `callbackSecret` (re-sent to the hub as `hub.secret`) and only the
 * topic is refreshed. The secret never rotates for a given row, so the hub and
 * we always agree on it and a verification GET can't leave them out of sync.
 * A renewal whose verification never arrives therefore can't invalidate the
 * still-working subscription — it keeps pushing under the current lease, and the
 * renewal sweep reverts it to polling only if it stays expired past the grace
 * window (see `renewExpiringSubscriptions`).
 *
 * A fresh subscribe (no row, or a row in a non-active state) takes the classic
 * path: state `pending`, and `websubActive` flips true only on verification. A
 * brand-new row mints a secret; a reused row keeps its existing one.
 *
 * @param feed - The feed with hub URL to subscribe to
 * @returns Result of the subscription attempt
 *
 * @example
 * if (feed.hubUrl && canUseWebSub()) {
 *   const result = await subscribeToHub(feed);
 *   if (result.success) {
 *     logger.info("WebSub subscription initiated", { feedId: feed.id });
 *   }
 * }
 */
export async function subscribeToHub(feed: Feed): Promise<SubscribeToHubResult> {
  if (!feed.hubUrl) {
    return { success: false, error: "Feed has no hub URL" };
  }

  if (!canUseWebSub()) {
    return { success: false, error: "WebSub is not available (no public callback URL)" };
  }

  // Use selfUrl as topic if available, otherwise fall back to feed URL
  const topicUrl = feed.selfUrl || feed.url;
  if (!topicUrl) {
    return { success: false, error: "Feed has no topic URL" };
  }

  // Check if subscription already exists for this feed + hub combination.
  // Reusing the row keeps the subscription ID (and thus the callback URL) stable
  // across renewals; a hub switch goes through deactivate + a fresh row instead.
  const existing = await db
    .select()
    .from(websubSubscriptions)
    .where(
      and(eq(websubSubscriptions.feedId, feed.id), eq(websubSubscriptions.hubUrl, feed.hubUrl))
    )
    .limit(1);

  // The subscription ID must be known before building the callback URL, since it
  // is part of the path.
  const existingRow = existing.length > 0 ? existing[0] : null;
  const subscriptionId = existingRow ? existingRow.id : generateUuidv7();

  // Reuse the row's existing secret for every (re)subscribe on that row — only a
  // brand-new row mints one. The secret is tied to this (feed, hub) pair and the
  // callback URL the hub already knows, so keeping it stable means a verification
  // GET (which carries no request identifier we could correlate) can never
  // promote a secret the hub isn't actually signing with. The hub only learns the
  // secret over HTTPS and it never rotates, which is fine for WebSub.
  const secret = existingRow ? existingRow.callbackSecret : generateCallbackSecret();

  // Renewing an already-active subscription: don't disrupt it. Keep it active
  // under its existing secret; the hub keeps pushing under the current lease
  // until it verifies this renewal (which advances expiresAt).
  const isRenewal = existingRow?.state === "active";

  const callbackUrl = generateCallbackUrl(feed.id, subscriptionId);
  if (!callbackUrl) {
    return { success: false, error: "Could not generate callback URL" };
  }

  if (isRenewal) {
    // Keep the row active and its secret valid. Not flipping to `pending` — and
    // not rotating the secret — means a renewal whose verification never arrives
    // can't invalidate the working subscription; the sweep reverts it to polling
    // only once it stays expired past the grace window (see
    // renewExpiringSubscriptions). Pushes are never dropped during a renewal.
    await db
      .update(websubSubscriptions)
      .set({
        topicUrl,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(websubSubscriptions.id, subscriptionId));

    logger.debug("Renewing active WebSub subscription", {
      subscriptionId,
      feedId: feed.id,
      hubUrl: feed.hubUrl,
    });
  } else if (existingRow) {
    // Non-active existing row (pending/unsubscribed): a fresh subscribe attempt on
    // the reused row. Keep its secret and clear any stale unsubscribe request so a
    // later hub-initiated unsubscribe verification can't be spuriously confirmed.
    await db
      .update(websubSubscriptions)
      .set({
        topicUrl,
        state: "pending",
        unsubscribeRequestedAt: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(websubSubscriptions.id, subscriptionId));

    logger.debug("Updating existing WebSub subscription", {
      subscriptionId,
      feedId: feed.id,
      hubUrl: feed.hubUrl,
    });
  } else {
    // Create new pending subscription
    await db.insert(websubSubscriptions).values({
      id: subscriptionId,
      feedId: feed.id,
      hubUrl: feed.hubUrl,
      topicUrl,
      callbackSecret: secret,
      state: "pending",
    });

    logger.debug("Created new WebSub subscription", {
      subscriptionId,
      feedId: feed.id,
      hubUrl: feed.hubUrl,
    });
  }

  // POST subscription request to hub
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HUB_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchWithSsrfProtection(feed.hubUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.topic": topicUrl,
        "hub.callback": callbackUrl,
        "hub.secret": secret,
        "hub.verify": "async",
      }).toString(),
      signal: controller.signal,
    });

    // Hub should return 202 Accepted for async verification
    // or 204 No Content for sync verification (already verified)
    if (response.status === 202 || response.status === 204) {
      logger.info("WebSub subscription request accepted", {
        subscriptionId,
        feedId: feed.id,
        hubUrl: feed.hubUrl,
        status: response.status,
      });

      return { success: true, subscriptionId };
    }

    // Handle error response (read a bounded prefix; we only log 200 chars)
    const errorBody = await readResponseBufferWithSizeLimit(response, 4096, feed.hubUrl).catch(() =>
      Buffer.alloc(0)
    );
    const errorMessage = `Hub returned ${response.status}: ${errorBody.toString().slice(0, 200)}`;

    await db
      .update(websubSubscriptions)
      .set({
        lastError: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(websubSubscriptions.id, subscriptionId));

    logger.warn("WebSub subscription request rejected", {
      subscriptionId,
      feedId: feed.id,
      hubUrl: feed.hubUrl,
      status: response.status,
      error: errorMessage,
    });

    return { success: false, subscriptionId, error: errorMessage };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await db
      .update(websubSubscriptions)
      .set({
        lastError: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(websubSubscriptions.id, subscriptionId));

    logger.warn("WebSub subscription request failed", {
      subscriptionId,
      feedId: feed.id,
      hubUrl: feed.hubUrl,
      error: errorMessage,
    });

    return { success: false, subscriptionId, error: errorMessage };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Result of verifying a hub verification challenge.
 */
export interface VerificationResult {
  /** Whether the verification was successful */
  success: boolean;
  /** The challenge response to return to the hub (if successful) */
  challenge?: string;
  /** Error message if verification failed */
  error?: string;
}

/**
 * Query parameters a hub sends on a verification callback.
 */
export interface VerificationParams {
  mode: string | null;
  topic: string | null;
  challenge: string | null;
  leaseSeconds: string | null;
}

/**
 * Applies a verification callback to an already-resolved subscription row:
 * validates the params + topic, then activates (subscribe) or confirms teardown
 * (unsubscribe). Shared by the per-subscription and legacy per-feed entry points.
 */
async function applyVerificationChallenge(
  subscription: WebsubSubscription,
  params: VerificationParams
): Promise<VerificationResult> {
  const { mode, topic, challenge, leaseSeconds } = params;
  const feedId = subscription.feedId;

  // Validate required parameters
  if (!mode || !topic || !challenge) {
    return { success: false, error: "Missing required parameters" };
  }

  if (mode !== "subscribe" && mode !== "unsubscribe") {
    return { success: false, error: `Unsupported mode: ${mode}` };
  }

  // Verify the topic matches what we subscribed to
  if (subscription.topicUrl !== topic) {
    logger.warn("WebSub verification topic mismatch", {
      feedId,
      expected: subscription.topicUrl,
      received: topic,
    });
    return { success: false, error: "Topic mismatch" };
  }

  if (mode === "unsubscribe") {
    return handleUnsubscribeVerification(feedId, subscription, challenge);
  }

  // Decline a subscribe verification for a subscription we've already abandoned
  // (the sweep gave up on a stalled renewal and reverted the feed to polling). A
  // late-arriving verification for that dead cycle must not resurrect the row —
  // doing so would flip websubActive back on while a fresh subscribe may be in
  // flight. The hub treats the declined verification as a dropped subscription.
  if (subscription.state === "unsubscribed") {
    logger.warn("WebSub subscribe verification for unsubscribed subscription - rejecting", {
      subscriptionId: subscription.id,
      feedId,
    });
    return { success: false, error: "Subscription is not awaiting verification" };
  }

  // Parse lease seconds. Hubs SHOULD send hub.lease_seconds but some don't; fall
  // back to a default so expiresAt is always set and the subscription stays in
  // the renewal filter's window (see DEFAULT_LEASE_SECONDS). Clamp the granted
  // lease to MAX_LEASE_SECONDS so a hub can't push our re-verification cadence
  // arbitrarily far out (see MAX_LEASE_SECONDS).
  const parsedLease = leaseSeconds ? parseInt(leaseSeconds, 10) : NaN;
  const grantedLease = !isNaN(parsedLease) && parsedLease > 0 ? parsedLease : DEFAULT_LEASE_SECONDS;
  const lease = Math.min(grantedLease, MAX_LEASE_SECONDS);
  const expiresAt = new Date(Date.now() + lease * 1000);

  // Activate (fresh subscribe) or extend the lease (renewal). Advancing expiresAt
  // into the future is what takes a renewed subscription back out of the sweep's
  // stale window; the secret is unchanged (it never rotates for a row).
  await db
    .update(websubSubscriptions)
    .set({
      state: "active",
      leaseSeconds: lease,
      expiresAt,
      lastChallengeAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(websubSubscriptions.id, subscription.id));

  // Update feed to mark WebSub as active
  await db
    .update(feeds)
    .set({ websubActive: true, updatedAt: new Date() })
    .where(eq(feeds.id, feedId));

  logger.info("WebSub subscription verified", {
    subscriptionId: subscription.id,
    feedId,
    leaseSeconds: lease,
    expiresAt,
  });

  return { success: true, challenge };
}

/**
 * Handles a WebSub verification callback for a specific subscription.
 *
 * This is the primary entry point: the callback URL carries both the feed ID and
 * the subscription ID (`/api/webhooks/websub/:feedId/:subscriptionId`), so the
 * callback resolves to exactly one subscription row — no ambiguity when a feed
 * has multiple subscription rows (e.g. after switching hubs).
 *
 * @param feedId - The feed ID from the callback URL
 * @param subscriptionId - The subscription ID from the callback URL
 * @param params - Query parameters from the hub
 * @returns Verification result with challenge or error
 */
export async function handleVerificationChallenge(
  feedId: string,
  subscriptionId: string,
  params: VerificationParams
): Promise<VerificationResult> {
  const [subscription] = await db
    .select()
    .from(websubSubscriptions)
    .where(and(eq(websubSubscriptions.id, subscriptionId), eq(websubSubscriptions.feedId, feedId)))
    .limit(1);

  if (!subscription) {
    logger.warn("WebSub verification for unknown subscription", {
      feedId,
      subscriptionId,
      topic: params.topic,
    });
    return { success: false, error: "Subscription not found" };
  }

  return applyVerificationChallenge(subscription, params);
}

/**
 * Handles a WebSub verification callback that arrived at the legacy per-feed
 * callback URL (`/api/webhooks/websub/:feedId`), used by subscriptions registered
 * before per-subscription callback URLs. Resolves the subscription by feed,
 * preferring the newest row since a hub switch can leave more than one.
 *
 * Transitional: once all subscriptions have renewed onto per-subscription URLs,
 * this and the legacy route can be removed.
 */
export async function handleVerificationChallengeByFeed(
  feedId: string,
  params: VerificationParams
): Promise<VerificationResult> {
  const [subscription] = await db
    .select()
    .from(websubSubscriptions)
    .where(eq(websubSubscriptions.feedId, feedId))
    .orderBy(desc(websubSubscriptions.createdAt))
    .limit(1);

  if (!subscription) {
    logger.warn("WebSub verification for unknown subscription", {
      feedId,
      topic: params.topic,
    });
    return { success: false, error: "Subscription not found" };
  }

  return applyVerificationChallenge(subscription, params);
}

/**
 * Handles an unsubscribe verification callback from a hub.
 *
 * Per W3C WebSub spec Section 5.3, we only confirm unsubscribes that we
 * requested (tracked via unsubscribe_requested_at). Unsubscribe verifications
 * we never requested are rejected: the callback URL (feedId) and topic URL are
 * both discoverable, so confirming unrequested unsubscribes would let anyone
 * silently downgrade a feed from push to backup polling. A hub that genuinely
 * drops us doesn't send a verification — it just stops delivering, and the
 * lease-renewal/polling machinery recovers from that.
 */
async function handleUnsubscribeVerification(
  feedId: string,
  subscription: WebsubSubscription,
  challenge: string
): Promise<VerificationResult> {
  if (!subscription.unsubscribeRequestedAt) {
    logger.warn("WebSub unsubscribe verification we never requested - rejecting", {
      subscriptionId: subscription.id,
      feedId,
    });
    return { success: false, error: "No unsubscribe was requested for this subscription" };
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    // Mark subscription as unsubscribed
    await tx
      .update(websubSubscriptions)
      .set({
        state: "unsubscribed",
        lastChallengeAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(websubSubscriptions.id, subscription.id));

    // Mark feed as not using WebSub
    await tx.update(feeds).set({ websubActive: false, updatedAt: now }).where(eq(feeds.id, feedId));
  });

  logger.info("WebSub unsubscribe verified (requested)", {
    subscriptionId: subscription.id,
    feedId,
  });

  return { success: true, challenge };
}

/**
 * Computes whether an X-Hub-Signature matches a body under a subscription's
 * shared secret. Shared by the per-subscription and legacy per-feed entry points.
 */
function computeSignatureValid(
  subscription: WebsubSubscription,
  signature: string,
  body: Buffer | string
): boolean {
  const feedId = subscription.feedId;

  // Parse signature format: "algorithm=hex_digest"
  const [algorithm, expectedDigest] = signature.split("=");
  if (!algorithm || !expectedDigest) {
    logger.warn("WebSub signature malformed", { feedId, signature });
    return false;
  }

  // Whitelist the hash algorithm per the WebSub spec. Without this, the hub
  // header dictates which digest we compute (e.g. a weak "md5="), letting an
  // attacker downgrade the check to an algorithm they can forge.
  const ALLOWED_ALGORITHMS = new Set(["sha1", "sha256", "sha384", "sha512"]);
  if (!ALLOWED_ALGORITHMS.has(algorithm.toLowerCase())) {
    logger.warn("WebSub signature uses disallowed algorithm", { feedId, algorithm });
    return false;
  }

  try {
    const hmac = createHmac(algorithm.toLowerCase(), subscription.callbackSecret);
    hmac.update(body);

    // Use timing-safe comparison to prevent timing attacks
    const expectedBuffer = Buffer.from(expectedDigest, "hex");
    const computedBuffer = hmac.digest();

    if (expectedBuffer.length !== computedBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, computedBuffer);
  } catch (error) {
    logger.warn("WebSub signature verification error", {
      feedId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return false;
  }
}

/**
 * Verifies the HMAC signature of a WebSub content notification for a specific
 * subscription (primary entry point; callback carries feed + subscription IDs).
 *
 * The hub signs the request body using the shared secret with HMAC-SHA256
 * (or other algorithms) and includes the signature in the X-Hub-Signature header.
 *
 * @param feedId - The feed ID from the callback URL
 * @param subscriptionId - The subscription ID from the callback URL
 * @param signature - The X-Hub-Signature header value (e.g., "sha256=abc123...")
 * @param body - The raw request body as a Buffer or string
 * @returns true if the signature is valid, false otherwise
 */
export async function verifyHmacSignature(
  feedId: string,
  subscriptionId: string,
  signature: string | null,
  body: Buffer | string
): Promise<boolean> {
  if (!signature) {
    logger.warn("WebSub notification missing signature", { feedId, subscriptionId });
    return false;
  }

  const [subscription] = await db
    .select()
    .from(websubSubscriptions)
    .where(
      and(
        eq(websubSubscriptions.id, subscriptionId),
        eq(websubSubscriptions.feedId, feedId),
        eq(websubSubscriptions.state, "active")
      )
    )
    .limit(1);

  if (!subscription) {
    logger.warn("WebSub notification for unknown/inactive subscription", {
      feedId,
      subscriptionId,
    });
    return false;
  }

  return computeSignatureValid(subscription, signature, body);
}

/**
 * Verifies the HMAC signature of a WebSub content notification that arrived at
 * the legacy per-feed callback URL. Resolves the active subscription by feed.
 *
 * Transitional: removable once all subscriptions have migrated to
 * per-subscription callback URLs.
 */
export async function verifyHmacSignatureByFeed(
  feedId: string,
  signature: string | null,
  body: Buffer | string
): Promise<boolean> {
  if (!signature) {
    logger.warn("WebSub notification missing signature", { feedId });
    return false;
  }

  const [subscription] = await db
    .select()
    .from(websubSubscriptions)
    .where(and(eq(websubSubscriptions.feedId, feedId), eq(websubSubscriptions.state, "active")))
    .limit(1);

  if (!subscription) {
    logger.warn("WebSub notification for unknown/inactive subscription", { feedId });
    return false;
  }

  return computeSignatureValid(subscription, signature, body);
}

/**
 * Result of renewing expiring WebSub subscriptions.
 */
export interface RenewSubscriptionsResult {
  /** Number of subscriptions that were checked */
  checked: number;
  /** Number of subscriptions successfully renewed */
  renewed: number;
  /** Number of subscriptions that failed to renew */
  failed: number;
  /** Details about failed renewals */
  errors: Array<{ feedId: string; error: string }>;
}

/**
 * Renews WebSub subscriptions that are expiring within the specified hours.
 *
 * This function should be called periodically (e.g., hourly) to ensure
 * subscriptions don't expire unexpectedly. A renewal keeps the subscription
 * `active` and re-requests the lease; a failed hub POST is retried on the next
 * sweep, not torn down. Only once a subscription stays expired past
 * `RENEWAL_STALL_GRACE_MS` — the hub accepted our (re)subscribe but never
 * verified — is it marked unsubscribed so polling takes over.
 *
 * @param hoursBeforeExpiry - Renew subscriptions expiring within this many hours (default: 24)
 * @returns Result with counts of checked, renewed, and failed subscriptions
 *
 * @example
 * // Run daily to renew subscriptions expiring in the next 24 hours
 * const result = await renewExpiringSubscriptions(24);
 * if (result.failed > 0) {
 *   logger.warn("Some WebSub renewals failed", { errors: result.errors });
 * }
 */
export async function renewExpiringSubscriptions(
  hoursBeforeExpiry: number = 24
): Promise<RenewSubscriptionsResult> {
  const result: RenewSubscriptionsResult = {
    checked: 0,
    renewed: 0,
    failed: 0,
    errors: [],
  };

  // Don't attempt renewal if WebSub is not available
  if (!canUseWebSub()) {
    logger.debug("WebSub not available, skipping renewal check");
    return result;
  }

  // Find subscriptions expiring within the specified time
  const expiryThreshold = new Date(Date.now() + hoursBeforeExpiry * 60 * 60 * 1000);

  const expiringSubs = await db
    .select({
      subscription: websubSubscriptions,
      feed: feeds,
    })
    .from(websubSubscriptions)
    .innerJoin(feeds, eq(websubSubscriptions.feedId, feeds.id))
    .where(
      and(
        eq(websubSubscriptions.state, "active"),
        lt(websubSubscriptions.expiresAt, expiryThreshold)
      )
    );

  result.checked = expiringSubs.length;

  if (expiringSubs.length === 0) {
    logger.debug("No WebSub subscriptions need renewal");
    return result;
  }

  logger.info("Found WebSub subscriptions to renew", {
    count: expiringSubs.length,
    hoursBeforeExpiry,
  });

  // Anything already this far past its lease has stalled: the hub took our
  // (re)subscribe but never verified it. Compare against this rather than a
  // stored "renewal started" time so a verification that raced the sweep (which
  // advances expiresAt) is never clobbered.
  const staleCutoff = new Date(Date.now() - RENEWAL_STALL_GRACE_MS);

  // Renew each expiring subscription
  for (const { subscription, feed } of expiringSubs) {
    // A renewal stuck long past expiry: give up and revert the feed to polling
    // instead of retrying forever. The subscription stayed `active` throughout,
    // so this is the only place a wedged renewal is cut off. The teardown is a
    // compare-and-swap (still active AND still stale) so a verification landing
    // between the select above and here — which advances expiresAt out of the
    // stale window — isn't torn down.
    if (subscription.expiresAt && subscription.expiresAt < staleCutoff) {
      const reverted = await revertStalledSubscription(subscription.id, feed.id, staleCutoff);
      if (reverted) {
        result.failed++;
        result.errors.push({ feedId: feed.id, error: RENEWAL_STALL_ERROR });
        logger.warn("WebSub renewal stalled past grace - reverting feed to polling", {
          subscriptionId: subscription.id,
          feedId: feed.id,
          expiresAt: subscription.expiresAt,
        });
      }
      continue;
    }

    try {
      const renewResult = await subscribeToHub(feed);

      if (renewResult.success) {
        result.renewed++;
        logger.info("WebSub subscription renewal requested", {
          subscriptionId: subscription.id,
          feedId: feed.id,
        });
      } else {
        // The hub POST was rejected or failed. Don't tear the subscription down:
        // it stays `active` under its secret (the hub keeps pushing under the
        // current lease), and the next sweep retries — until it drifts past
        // RENEWAL_STALL_GRACE_MS, after which the check above reverts to polling.
        // subscribeToHub already recorded lastError.
        result.failed++;
        result.errors.push({
          feedId: feed.id,
          error: renewResult.error ?? "Renewal failed",
        });
        logger.warn("WebSub renewal request failed - will retry next sweep", {
          subscriptionId: subscription.id,
          feedId: feed.id,
          error: renewResult.error,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Unexpected error - also leave the subscription active and retry next
      // sweep rather than tearing down a working subscription over a transient
      // fault. The stale-cutoff check bounds how long this can repeat.
      result.failed++;
      result.errors.push({
        feedId: feed.id,
        error: errorMessage,
      });
      logger.warn("WebSub renewal errored - will retry next sweep", {
        subscriptionId: subscription.id,
        feedId: feed.id,
        error: errorMessage,
      });
    }
  }

  logger.info("WebSub renewal completed", {
    checked: result.checked,
    renewed: result.renewed,
    failed: result.failed,
  });

  return result;
}

/**
 * Reverts a stalled WebSub subscription to polling, guarded by a compare-and-swap.
 *
 * The subscription row is only marked `unsubscribed` (and the feed's
 * `websubActive` cleared) if it is *still* `active` and *still* stale
 * (`expiresAt < staleCutoff`). A verification that landed between the renewal
 * sweep's snapshot select and this call advances `expiresAt` out of the stale
 * window, so the CAS matches no rows and the freshly-renewed subscription is left
 * untouched. Returns whether the subscription was actually reverted.
 */
async function revertStalledSubscription(
  subscriptionId: string,
  feedId: string,
  staleCutoff: Date
): Promise<boolean> {
  const now = new Date();
  const reverted = await db
    .update(websubSubscriptions)
    .set({
      state: "unsubscribed",
      lastError: RENEWAL_STALL_ERROR,
      unsubscribeRequestedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(websubSubscriptions.id, subscriptionId),
        eq(websubSubscriptions.state, "active"),
        lt(websubSubscriptions.expiresAt, staleCutoff)
      )
    )
    .returning({ id: websubSubscriptions.id });

  if (reverted.length === 0) {
    // A verification (or another sweep) raced us; leave the row alone.
    return false;
  }

  await db
    .update(feeds)
    .set({
      websubActive: false,
      updatedAt: new Date(),
    })
    .where(eq(feeds.id, feedId));

  logger.warn("WebSub subscription marked as failed", {
    subscriptionId,
    feedId,
    error: RENEWAL_STALL_ERROR,
  });
  return true;
}

/**
 * Deactivates WebSub for a feed when the hub URL is removed.
 * Marks any active subscription as unsubscribed and sets websubActive to false.
 *
 * @param feedId - The feed ID
 * @returns true if WebSub was deactivated, false if it wasn't active
 */
export async function deactivateWebsub(feedId: string): Promise<boolean> {
  // Find active subscription for this feed
  const [subscription] = await db
    .select()
    .from(websubSubscriptions)
    .where(and(eq(websubSubscriptions.feedId, feedId), eq(websubSubscriptions.state, "active")))
    .limit(1);

  if (!subscription) {
    // No active subscription - just ensure websubActive is false
    await db
      .update(feeds)
      .set({
        websubActive: false,
        updatedAt: new Date(),
      })
      .where(eq(feeds.id, feedId));

    return false;
  }

  // Mark subscription as unsubscribed
  const now = new Date();
  await db
    .update(websubSubscriptions)
    .set({
      state: "unsubscribed",
      lastError: "Hub URL removed from feed",
      unsubscribeRequestedAt: now,
      updatedAt: now,
    })
    .where(eq(websubSubscriptions.id, subscription.id));

  // Mark feed as not using WebSub
  await db
    .update(feeds)
    .set({
      websubActive: false,
      updatedAt: now,
    })
    .where(eq(feeds.id, feedId));

  logger.info("WebSub deactivated - hub URL removed from feed", {
    subscriptionId: subscription.id,
    feedId,
  });

  return true;
}
