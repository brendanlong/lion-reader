/**
 * Inbound Email Processing
 *
 * Processes incoming newsletter emails and creates feed entries.
 * This module provides the core logic for handling emails from any provider.
 */

import { createHash } from "crypto";
import { eq, and, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { generateSummary } from "../html/strip-html";
import { cleanContent } from "../feed/content-cleaner";
import {
  feeds,
  entries,
  subscriptions,
  userEntries,
  ingestAddresses,
  blockedSenders,
  type NewEntry,
} from "../db/schema";
import { generateUuidv7 } from "../../lib/uuidv7";
import { publishNewEntry, publishSubscriptionCreated } from "../redis/pubsub";
import { logger } from "@/lib/logger";

// ============================================================================
// Types
// ============================================================================

/**
 * Normalized inbound email format.
 * Provider-specific webhooks parse their format into this structure.
 */
export interface InboundEmail {
  /** Recipient address (e.g., "token@ingest.lionreader.com") */
  to: string;
  /** Sender information */
  from: {
    /** Sender email address */
    address: string;
    /** Sender display name (optional) */
    name?: string;
  };
  /** Email subject */
  subject: string;
  /** Message-ID header (used as entry GUID) */
  messageId: string;
  /** HTML content (optional) */
  html?: string;
  /** Plain text content (optional) */
  text?: string;
  /** Relevant headers */
  headers: {
    /** List-Unsubscribe header value */
    listUnsubscribe?: string;
    /** List-Unsubscribe-Post header value */
    listUnsubscribePost?: string;
  };
  /** Provider's spam score (optional) */
  spamScore?: number;
  /** Provider's spam verdict (optional) */
  isSpam?: boolean;
}

/**
 * Result of processing an inbound email.
 */
export interface ProcessEmailResult {
  /** Whether processing succeeded */
  success: boolean;
  /** Error message if processing failed */
  error?: string;
  /** ID of the created entry (if successful) */
  entryId?: string;
  /** ID of the feed (if successful) */
  feedId?: string;
}

// ============================================================================
// Pure Helper Functions
// ============================================================================

/**
 * Normalizes a sender email address.
 * - Lowercases the entire email
 * - Strips plus codes (newsletter+tracking@example.com -> newsletter@example.com)
 *
 * @param email - The sender email to normalize
 * @returns Normalized email address
 */
function normalizeSenderEmail(email: string): string {
  const lowered = email.toLowerCase();
  const atIndex = lowered.lastIndexOf("@");

  if (atIndex === -1) {
    // Invalid email, return as-is lowercased
    return lowered;
  }

  const localPart = lowered.slice(0, atIndex);
  const domain = lowered.slice(atIndex + 1);

  // Strip plus codes from local part
  const plusIndex = localPart.indexOf("+");
  const normalizedLocal = plusIndex === -1 ? localPart : localPart.slice(0, plusIndex);

  return `${normalizedLocal}@${domain}`;
}

/**
 * Extracts the token from a recipient address.
 * Handles plus codes in the recipient (e.g., "abc123+test@ingest.lionreader.com" -> "abc123").
 *
 * @param toAddress - The recipient email address
 * @returns The extracted token
 */
function extractToken(toAddress: string): string {
  const lowered = toAddress.toLowerCase();
  const atIndex = lowered.lastIndexOf("@");

  // Get local part (before @)
  const localPart = atIndex === -1 ? lowered : lowered.slice(0, atIndex);

  // Strip plus codes
  const plusIndex = localPart.indexOf("+");
  return plusIndex === -1 ? localPart : localPart.slice(0, plusIndex);
}

/**
 * Parses a List-Unsubscribe header and extracts the mailto: URL.
 * The header can contain multiple URLs in angle brackets, comma-separated.
 * Example: "<mailto:unsub@example.com>, <https://example.com/unsub>"
 *
 * @param header - The List-Unsubscribe header value
 * @returns The mailto: URL or null if not found
 */
function parseListUnsubscribeMailto(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  // Match mailto: URLs in angle brackets
  const mailtoRegex = /<(mailto:[^>]+)>/gi;
  let match: RegExpExecArray | null;

  while ((match = mailtoRegex.exec(header)) !== null) {
    if (match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Parses a List-Unsubscribe header and extracts the https: URL.
 * The header can contain multiple URLs in angle brackets, comma-separated.
 * Example: "<mailto:unsub@example.com>, <https://example.com/unsub>"
 *
 * @param header - The List-Unsubscribe header value
 * @returns The https: URL or null if not found
 */
function parseListUnsubscribeHttps(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  // Match https: URLs in angle brackets
  const httpsRegex = /<(https:[^>]+)>/gi;
  let match: RegExpExecArray | null;

  while ((match = httpsRegex.exec(header)) !== null) {
    if (match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Generates a SHA-256 content hash for an email.
 * Based on subject and content for duplicate detection.
 *
 * @param subject - Email subject
 * @param content - Email content (HTML or text)
 * @returns Hexadecimal SHA-256 hash string
 */
function generateEmailContentHash(subject: string, content: string): string {
  const hashInput = `${subject}\n${content}`;
  return createHash("sha256").update(hashInput, "utf8").digest("hex");
}

// ============================================================================
// Main Processing Function
// ============================================================================

/**
 * Processes an inbound email.
 *
 * Flow:
 * 1. Extract token from recipient
 * 2. Find ingest address (reject if not found or deleted)
 * 3. Normalize sender email
 * 4. Check if sender is blocked (reject silently)
 * 5. Find or create email feed for (user_id, sender_email)
 * 6. Auto-create subscription if new feed
 * 7. Check for duplicate Message-ID
 * 8. Create entry with email content
 * 9. Publish real-time event via Redis
 *
 * @param email - The normalized inbound email
 * @returns Processing result
 */
export async function processInboundEmail(email: InboundEmail): Promise<ProcessEmailResult> {
  // 1. Extract token from recipient
  const token = extractToken(email.to);

  if (!token) {
    logger.info("Email rejected: empty token in recipient", { to: email.to });
    return { success: false, error: "Invalid recipient address" };
  }

  // 2. Find ingest address
  const [ingestAddress] = await db
    .select()
    .from(ingestAddresses)
    .where(eq(ingestAddresses.token, token))
    .limit(1);

  if (!ingestAddress) {
    logger.info("Email rejected: ingest address not found", { token });
    return { success: false, error: "Invalid ingest address" };
  }

  if (ingestAddress.deletedAt) {
    logger.info("Email rejected: ingest address deleted", {
      token,
      deletedAt: ingestAddress.deletedAt,
    });
    return { success: false, error: "Ingest address deleted" };
  }

  const userId = ingestAddress.userId;

  // 3. Normalize sender email
  const senderEmail = normalizeSenderEmail(email.from.address);

  // 4. Check if sender is blocked
  const [blockedSender] = await db
    .select()
    .from(blockedSenders)
    .where(and(eq(blockedSenders.userId, userId), eq(blockedSenders.senderEmail, senderEmail)))
    .limit(1);

  if (blockedSender) {
    logger.info("Email rejected: sender blocked", { senderEmail, userId });
    return { success: false, error: "Sender blocked" };
  }

  // 5. Upsert email feed for (user_id, sender_email)
  // ON CONFLICT updates updatedAt to ensure RETURNING always gives us the feed
  const now = new Date();
  const feedId = generateUuidv7();
  const feedTitle = email.from.name || senderEmail;

  let [feed] = await db
    .insert(feeds)
    .values({
      id: feedId,
      type: "email",
      userId,
      emailSenderPattern: senderEmail,
      title: feedTitle,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [feeds.userId, feeds.emailSenderPattern],
    })
    .returning();

  const isNewFeed = feed != null;
  if (isNewFeed) {
    logger.info("Created email feed", { feedId, userId, senderEmail, title: feedTitle });
  } else {
    // Feed already exists, select since we can't return from `on conflict do nothing`
    [feed] = await db
      .select()
      .from(feeds)
      .where(
        and(
          eq(feeds.userId, userId),
          eq(feeds.emailSenderPattern, senderEmail),
          eq(feeds.type, "email")
        )
      )
      .limit(1);
  }

  // 6. Upsert subscription: insert new, or reactivate if unsubscribed
  // RETURNING only returns a row if inserted OR updated (not if already active)
  const subscriptionId = generateUuidv7();

  const [upsertedSubscription] = await db
    .insert(subscriptions)
    .values({
      id: subscriptionId,
      userId,
      feedId: feed.id,
      subscribedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [subscriptions.userId, subscriptions.feedId],
      set: { unsubscribedAt: null, updatedAt: now },
      where: isNotNull(subscriptions.unsubscribedAt),
    })
    .returning();

  if (upsertedSubscription) {
    const isNewSubscription = upsertedSubscription.id === subscriptionId;
    logger.info(isNewSubscription ? "Created subscription" : "Reactivated subscription", {
      subscriptionId: upsertedSubscription.id,
      feedId: feed.id,
      userId,
    });

    // Publish subscription_created event so SSE handlers subscribe to the feed channel
    // This must happen BEFORE the new_entry event so the client receives the entry notification
    publishSubscriptionCreated(
      userId,
      feed.id,
      upsertedSubscription.id,
      upsertedSubscription.updatedAt,
      {
        id: upsertedSubscription.id,
        feedId: feed.id,
        customTitle: upsertedSubscription.customTitle,
        subscribedAt: upsertedSubscription.subscribedAt.toISOString(),
        unreadCount: 1,
        tags: [],
      },
      {
        id: feed.id,
        type: "email",
        url: null,
        title: feed.title,
        description: null,
        siteUrl: null,
      }
    ).catch((err) => {
      logger.error("Failed to publish subscription_created event for email feed", {
        feedId: feed.id,
        subscriptionId: upsertedSubscription.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // 7. Check for duplicate Message-ID
  const [existingEntry] = await db
    .select()
    .from(entries)
    .where(and(eq(entries.feedId, feed.id), eq(entries.guid, email.messageId)))
    .limit(1);

  if (existingEntry) {
    logger.info("Email rejected: duplicate Message-ID", {
      messageId: email.messageId,
      feedId: feed.id,
    });
    return { success: false, error: "Duplicate email" };
  }

  // 8. Create entry with email content
  const contentOriginal = email.html || email.text || "";
  const contentHash = generateEmailContentHash(email.subject, contentOriginal);

  // Try to clean HTML content using Readability for better reading experience.
  // This extracts main content and strips email boilerplate (headers, footers, unsubscribe links).
  // Use lower thresholds than web articles since emails are often shorter.
  // Set to null if cleaning fails - UI only shows toggle when both versions exist.
  let contentCleaned: string | null = null;
  if (email.html) {
    const cleaned = cleanContent(email.html, {
      minContentLength: 50,
      minCleanedLength: 20,
    });
    if (cleaned) {
      contentCleaned = cleaned.content;
      logger.debug("Email content cleaned with Readability", {
        originalLength: email.html.length,
        cleanedLength: cleaned.content.length,
      });
    }
  }

  // Generate summary from cleaned content if available, otherwise from original.
  // This ensures summaries are based on the main content and not email boilerplate.
  const contentForSummary = contentCleaned ?? contentOriginal;
  const summary = generateSummary(contentForSummary);

  // Parse List-Unsubscribe headers
  const listUnsubscribeMailto = parseListUnsubscribeMailto(email.headers.listUnsubscribe);
  const listUnsubscribeHttps = parseListUnsubscribeHttps(email.headers.listUnsubscribe);
  const listUnsubscribePost =
    email.headers.listUnsubscribePost?.toLowerCase().includes("one-click") ?? false;

  const entryId = generateUuidv7();

  const newEntry: NewEntry = {
    id: entryId,
    feedId: feed.id,
    type: "email",
    guid: email.messageId,
    title: email.subject,
    author: email.from.name || email.from.address,
    contentOriginal,
    contentCleaned,
    summary,
    publishedAt: now,
    fetchedAt: now,
    contentHash,
    spamScore: email.spamScore ?? null,
    isSpam: email.isSpam ?? false,
    listUnsubscribeMailto,
    listUnsubscribeHttps,
    listUnsubscribePost,
  };

  await db.insert(entries).values(newEntry);

  // Create user_entry to make it visible to the user
  await db.insert(userEntries).values({
    userId,
    entryId,
  });

  logger.info("Email processed successfully", {
    feedId: feed.id,
    entryId,
    senderEmail,
    messageId: email.messageId,
    isNewFeed,
    isSpam: email.isSpam ?? false,
  });

  // 9. Publish real-time event via Redis
  // Fire and forget - we don't want publishing failures to affect email processing
  publishNewEntry(feed.id, entryId, now, "email").catch((err) => {
    logger.error("Failed to publish new_entry event for email", {
      feedId: feed.id,
      entryId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    success: true,
    entryId,
    feedId: feed.id,
  };
}
