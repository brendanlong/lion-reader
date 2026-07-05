/**
 * WebSub utility functions.
 * Provides helpers for WebSub (PubSubHubbub) support including:
 * - Checking if WebSub can be used (requires public URL)
 * - Generating callback URLs and secrets
 * - Subscribing to WebSub hubs
 * - Verifying HMAC signatures on content notifications
 */

import { randomBytes, createHmac, timingSafeEqual } from "crypto";
import { eq, and, lt } from "drizzle-orm";
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
 * @param feedId - The feed ID
 * @returns The callback URL or null if WebSub is not available
 */
function generateCallbackUrl(feedId: string): string | null {
  const baseUrl = getWebsubCallbackBaseUrl();
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl}/api/webhooks/websub/${feedId}`;
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

  const callbackUrl = generateCallbackUrl(feed.id);
  if (!callbackUrl) {
    return { success: false, error: "Could not generate callback URL" };
  }

  // Use selfUrl as topic if available, otherwise fall back to feed URL
  const topicUrl = feed.selfUrl || feed.url;
  if (!topicUrl) {
    return { success: false, error: "Feed has no topic URL" };
  }

  const secret = generateCallbackSecret();

  // Check if subscription already exists for this feed + hub combination
  const existing = await db
    .select()
    .from(websubSubscriptions)
    .where(
      and(eq(websubSubscriptions.feedId, feed.id), eq(websubSubscriptions.hubUrl, feed.hubUrl))
    )
    .limit(1);

  let subscriptionId: string;

  if (existing.length > 0) {
    // Update existing subscription with new secret
    subscriptionId = existing[0].id;
    await db
      .update(websubSubscriptions)
      .set({
        topicUrl,
        callbackSecret: secret,
        state: "pending",
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
    subscriptionId = generateUuidv7();
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
 * Handles a WebSub verification callback from a hub.
 *
 * The hub sends a GET request with query parameters to verify
 * that we want to receive notifications.
 *
 * @param feedId - The feed ID from the callback URL
 * @param params - Query parameters from the hub
 * @returns Verification result with challenge or error
 *
 * @example
 * // In your API route handler:
 * const result = await handleVerificationChallenge(feedId, {
 *   mode: searchParams.get("hub.mode"),
 *   topic: searchParams.get("hub.topic"),
 *   challenge: searchParams.get("hub.challenge"),
 *   leaseSeconds: searchParams.get("hub.lease_seconds"),
 * });
 *
 * if (result.success) {
 *   return new Response(result.challenge, { status: 200 });
 * } else {
 *   return new Response(result.error, { status: 404 });
 * }
 */
export async function handleVerificationChallenge(
  feedId: string,
  params: {
    mode: string | null;
    topic: string | null;
    challenge: string | null;
    leaseSeconds: string | null;
  }
): Promise<VerificationResult> {
  const { mode, topic, challenge, leaseSeconds } = params;

  // Validate required parameters
  if (!mode || !topic || !challenge) {
    return { success: false, error: "Missing required parameters" };
  }

  if (mode !== "subscribe" && mode !== "unsubscribe") {
    return { success: false, error: `Unsupported mode: ${mode}` };
  }

  // Find the subscription for this feed
  const [subscription] = await db
    .select()
    .from(websubSubscriptions)
    .where(eq(websubSubscriptions.feedId, feedId))
    .limit(1);

  if (!subscription) {
    logger.warn("WebSub verification for unknown subscription", { feedId, topic });
    return { success: false, error: "Subscription not found" };
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

  // Parse lease seconds. Hubs SHOULD send hub.lease_seconds but some don't; fall
  // back to a default so expiresAt is always set and the subscription stays in
  // the renewal filter's window (see DEFAULT_LEASE_SECONDS).
  const parsedLease = leaseSeconds ? parseInt(leaseSeconds, 10) : NaN;
  const lease = !isNaN(parsedLease) && parsedLease > 0 ? parsedLease : DEFAULT_LEASE_SECONDS;
  const expiresAt = new Date(Date.now() + lease * 1000);

  // Update subscription to active
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
 * Verifies the HMAC signature of a WebSub content notification.
 *
 * The hub signs the request body using the shared secret with HMAC-SHA256
 * (or other algorithms) and includes the signature in the X-Hub-Signature header.
 *
 * @param feedId - The feed ID from the callback URL
 * @param signature - The X-Hub-Signature header value (e.g., "sha256=abc123...")
 * @param body - The raw request body as a Buffer or string
 * @returns true if the signature is valid, false otherwise
 *
 * @example
 * const signatureHeader = req.headers.get("x-hub-signature");
 * const body = await req.text();
 *
 * if (!verifyHmacSignature(feedId, signatureHeader, body)) {
 *   return new Response("Invalid signature", { status: 403 });
 * }
 */
export async function verifyHmacSignature(
  feedId: string,
  signature: string | null,
  body: Buffer | string
): Promise<boolean> {
  if (!signature) {
    logger.warn("WebSub notification missing signature", { feedId });
    return false;
  }

  // Find the subscription
  const [subscription] = await db
    .select()
    .from(websubSubscriptions)
    .where(and(eq(websubSubscriptions.feedId, feedId), eq(websubSubscriptions.state, "active")))
    .limit(1);

  if (!subscription) {
    logger.warn("WebSub notification for unknown/inactive subscription", { feedId });
    return false;
  }

  // Parse signature format: "algorithm=hex_digest"
  const [algorithm, expectedDigest] = signature.split("=");
  if (!algorithm || !expectedDigest) {
    logger.warn("WebSub signature malformed", { feedId, signature });
    return false;
  }

  try {
    // Compute expected signature (hub sends sha1, sha256, etc. which Node crypto accepts directly)
    const hmac = createHmac(algorithm, subscription.callbackSecret);
    hmac.update(body);
    const computedDigest = hmac.digest("hex");

    // Use timing-safe comparison to prevent timing attacks
    const expectedBuffer = Buffer.from(expectedDigest, "hex");
    const computedBuffer = Buffer.from(computedDigest, "hex");

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
 * This function should be called periodically (e.g., daily) to ensure
 * subscriptions don't expire unexpectedly. If renewal fails, the subscription
 * is marked as unsubscribed and polling will take over.
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

  // Renew each expiring subscription
  for (const { subscription, feed } of expiringSubs) {
    try {
      const renewResult = await subscribeToHub(feed);

      if (renewResult.success) {
        result.renewed++;
        logger.info("WebSub subscription renewed", {
          subscriptionId: subscription.id,
          feedId: feed.id,
        });
      } else {
        // Renewal request failed - mark as unsubscribed so polling takes over
        await markSubscriptionFailed(
          subscription.id,
          feed.id,
          renewResult.error ?? "Renewal failed"
        );
        result.failed++;
        result.errors.push({
          feedId: feed.id,
          error: renewResult.error ?? "Renewal failed",
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Mark as unsubscribed so polling takes over
      await markSubscriptionFailed(subscription.id, feed.id, errorMessage);
      result.failed++;
      result.errors.push({
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
 * Marks a WebSub subscription as failed/unsubscribed.
 * Updates both the subscription state and the feed's websubActive flag.
 */
async function markSubscriptionFailed(
  subscriptionId: string,
  feedId: string,
  error: string
): Promise<void> {
  const now = new Date();
  await db
    .update(websubSubscriptions)
    .set({
      state: "unsubscribed",
      lastError: error,
      unsubscribeRequestedAt: now,
      updatedAt: now,
    })
    .where(eq(websubSubscriptions.id, subscriptionId));

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
    error,
  });
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
