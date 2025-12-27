/**
 * WebSub utility functions.
 * Provides helpers for WebSub (PubSubHubbub) support including:
 * - Checking if WebSub can be used (requires public URL)
 * - Generating callback URLs and secrets
 * - Subscribing to WebSub hubs
 * - Verifying HMAC signatures on content notifications
 */

import { randomBytes, createHmac, timingSafeEqual } from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { feeds, websubSubscriptions, type Feed } from "../db/schema";
import { generateUuidv7 } from "../../lib/uuidv7";
import { logger } from "@/lib/logger";

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
export function getWebsubCallbackBaseUrl(): string | null {
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
export function generateCallbackUrl(feedId: string): string | null {
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
  try {
    const response = await fetch(feed.hubUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.topic": topicUrl,
        "hub.callback": callbackUrl,
        "hub.secret": secret,
      }).toString(),
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

    // Handle error response
    const errorText = await response.text();
    const errorMessage = `Hub returned ${response.status}: ${errorText.slice(0, 200)}`;

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

  // We only handle subscribe mode currently
  // (unsubscribe would be handled similarly if needed)
  if (mode !== "subscribe") {
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

  // Parse lease seconds (if provided)
  const lease = leaseSeconds ? parseInt(leaseSeconds, 10) : null;
  const expiresAt = lease ? new Date(Date.now() + lease * 1000) : null;

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

  // Map algorithm names (hub may use sha1, sha256, sha384, sha512)
  const hmacAlgorithm = algorithm.replace("sha", "sha");

  try {
    // Compute expected signature
    const hmac = createHmac(hmacAlgorithm, subscription.callbackSecret);
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
 * Gets an active WebSub subscription for a feed.
 *
 * @param feedId - The feed ID
 * @returns The subscription or null if not found/active
 */
export async function getActiveSubscription(feedId: string) {
  const [subscription] = await db
    .select()
    .from(websubSubscriptions)
    .where(and(eq(websubSubscriptions.feedId, feedId), eq(websubSubscriptions.state, "active")))
    .limit(1);

  return subscription ?? null;
}

/**
 * Unsubscribes from a WebSub hub for a feed.
 *
 * Sends an unsubscribe request to the hub and updates the local subscription state.
 *
 * @param feedId - The feed ID to unsubscribe
 * @returns true if unsubscribe was successful, false otherwise
 */
export async function unsubscribeFromHub(feedId: string): Promise<boolean> {
  const subscription = await getActiveSubscription(feedId);
  if (!subscription) {
    return false;
  }

  const callbackUrl = generateCallbackUrl(feedId);
  if (!callbackUrl) {
    return false;
  }

  try {
    const response = await fetch(subscription.hubUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        "hub.mode": "unsubscribe",
        "hub.topic": subscription.topicUrl,
        "hub.callback": callbackUrl,
      }).toString(),
    });

    if (response.status === 202 || response.status === 204) {
      // Mark subscription as unsubscribed
      await db
        .update(websubSubscriptions)
        .set({
          state: "unsubscribed",
          updatedAt: new Date(),
        })
        .where(eq(websubSubscriptions.id, subscription.id));

      // Update feed WebSub status
      await db
        .update(feeds)
        .set({ websubActive: false, updatedAt: new Date() })
        .where(eq(feeds.id, feedId));

      logger.info("WebSub unsubscribe successful", { feedId, hubUrl: subscription.hubUrl });
      return true;
    }

    logger.warn("WebSub unsubscribe rejected", {
      feedId,
      hubUrl: subscription.hubUrl,
      status: response.status,
    });
    return false;
  } catch (error) {
    logger.warn("WebSub unsubscribe failed", {
      feedId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return false;
  }
}
