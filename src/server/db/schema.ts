import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * ParagraphMapping represents the mapping from a narration paragraph to
 * one or more original HTML paragraphs. This enables highlighting the
 * current paragraph during audio narration playback.
 *
 * Format: { n: narrationIndex, o: [originalIndices] }
 * - n: The narration paragraph index (0-based)
 * - o: Array of original paragraph indices this narration maps to
 *      (can be multiple if the LLM combined paragraphs)
 */
export interface ParagraphMapping {
  n: number;
  o: number[];
}

// ============================================================================
// ENUMS
// ============================================================================

export const feedTypeEnum = pgEnum("feed_type", ["rss", "atom", "json", "email", "saved"]);

export const websubStateEnum = pgEnum("websub_state", ["pending", "active", "unsubscribed"]);

// ============================================================================
// AUTHENTICATION
// ============================================================================

/**
 * Invites table - stores invite tokens for controlled signups.
 * Each invite is one-time use and expires after 7 days.
 */
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey(),
    token: text("token").unique().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByUserId: uuid("used_by_user_id"), // FK added after users table defined
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_invites_token").on(table.token),
    index("idx_invites_expires").on(table.expiresAt),
  ]
);

/**
 * Users table - stores user accounts.
 * Primary key uses UUIDv7 for time-ordering and global uniqueness.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").unique().notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  passwordHash: text("password_hash"), // null if OAuth-only (future)
  inviteId: uuid("invite_id").references(() => invites.id, { onDelete: "set null" }),

  // Preferences
  showSpam: boolean("show_spam").notNull().default(false), // Show spam entries from email feeds

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Sessions table - stores user sessions.
 * Token is stored as SHA-256 hash (never raw).
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").unique().notNull(), // SHA-256 of session token

    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_sessions_user").on(table.userId),
    index("idx_sessions_token").on(table.tokenHash),
  ]
);

// ============================================================================
// OAUTH ACCOUNTS
// ============================================================================

/**
 * OAuth accounts table - links OAuth providers to user accounts.
 * Enables login via Google, Apple, etc.
 */
export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // 'google', 'apple'
    providerAccountId: text("provider_account_id").notNull(),

    // Token storage for potential API access
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Unique constraint on provider + provider_account_id
    unique("uq_oauth_accounts_provider_account").on(table.provider, table.providerAccountId),
    // Index for looking up OAuth accounts by user
    index("idx_oauth_accounts_user").on(table.userId),
  ]
);

// ============================================================================
// FEEDS (shared canonical data)
// ============================================================================

/**
 * Feeds table - stores canonical feed data shared across users.
 * For email feeds (type='email'), the feed is user-specific and uses email_sender_pattern.
 * For URL-based feeds (rss/atom/json), feeds are shared across users.
 */
export const feeds = pgTable(
  "feeds",
  {
    id: uuid("id").primaryKey(),
    type: feedTypeEnum("type").notNull(),

    url: text("url").unique(), // For URL-based feeds

    // For email feeds - user ownership and sender pattern
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }), // Only set for email feeds
    emailSenderPattern: text("email_sender_pattern"), // Normalized sender email for email feeds

    // Metadata from feed
    title: text("title"),
    description: text("description"),
    siteUrl: text("site_url"),

    // Fetch state
    etag: text("etag"),
    lastModifiedHeader: text("last_modified_header"),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    nextFetchAt: timestamp("next_fetch_at", { withTimezone: true }),

    // Error tracking
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastError: text("last_error"),

    // WebSub support
    hubUrl: text("hub_url"), // WebSub hub URL discovered from feed
    selfUrl: text("self_url"), // Canonical feed URL (topic URL)
    websubActive: boolean("websub_active").notNull().default(false), // Whether WebSub is currently active

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_feeds_next_fetch").on(table.nextFetchAt),
    // Email and saved feeds require user_id, other feeds must not have it
    check("feed_type_user_id", sql`(type IN ('email', 'saved')) = (user_id IS NOT NULL)`),
    // Unique constraint for email feeds: one feed per (user, sender)
    unique("uq_feeds_email_user_sender").on(table.userId, table.emailSenderPattern),
    // Unique constraint for saved feeds: one saved feed per user (partial index)
    // Note: This is created as a raw SQL index in the migration
  ]
);

// ============================================================================
// ENTRIES (shared canonical data)
// ============================================================================

/**
 * Entries table - stores feed entries.
 * UUIDv7 primary key provides time ordering.
 */
export const entries = pgTable(
  "entries",
  {
    id: uuid("id").primaryKey(), // UUIDv7 gives us time ordering
    feedId: uuid("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    type: feedTypeEnum("type").notNull(), // Denormalized from feed for type-specific constraints and queries

    // Identifier from source - meaning varies by type:
    // - rss/atom/json: <guid> or <id> from feed
    // - email: Message-ID header
    // - saved: the URL being saved
    guid: text("guid").notNull(),

    // Content
    url: text("url"),
    title: text("title"),
    author: text("author"),
    contentOriginal: text("content_original"),
    contentCleaned: text("content_cleaned"), // Readability-cleaned HTML
    summary: text("summary"), // truncated for previews

    // Saved article metadata (only for type='saved')
    siteName: text("site_name"),
    imageUrl: text("image_url"),

    // Timestamps
    publishedAt: timestamp("published_at", { withTimezone: true }), // from feed (may be null/inaccurate)
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(), // when we first saw it
    // Last time this entry was seen in a feed fetch (rss/atom/json only, NULL for email/saved)
    // Used to determine visibility: entry.lastSeenAt = feed.lastFetchedAt means it's in the current feed
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),

    // Version tracking
    contentHash: text("content_hash").notNull(), // for detecting updates

    // Spam tracking (for email entries)
    spamScore: real("spam_score"), // Provider's spam score
    isSpam: boolean("is_spam").notNull().default(false), // Provider's spam verdict

    // List-Unsubscribe info (for email entries, used when unsubscribing)
    listUnsubscribeMailto: text("list_unsubscribe_mailto"), // mailto: URL from header
    listUnsubscribeHttps: text("list_unsubscribe_https"), // https: URL from header
    listUnsubscribePost: boolean("list_unsubscribe_post"), // true if one-click POST supported

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Unique constraint on feed + guid
    unique("uq_entries_feed_guid").on(table.feedId, table.guid),
    // For listing entries by feed, ordered by time (UUIDv7 is time-ordered)
    index("idx_entries_feed").on(table.feedId, table.id),
    // For finding entries by fetched time (visibility filtering)
    index("idx_entries_fetched").on(table.feedId, table.fetchedAt),
    // For filtering spam entries
    index("idx_entries_spam").on(table.feedId, table.isSpam),
    // For filtering by entry type
    index("idx_entries_type").on(table.type),
    // Type-specific check constraints (created via raw SQL in migrations):
    // - entries_spam_only_email: spam fields only for email entries
    // - entries_unsubscribe_only_email: unsubscribe fields only for email entries
    // - entries_saved_metadata_only_saved: site_name/image_url only for saved entries
    // - entries_last_seen_only_fetched: last_seen_at required for rss/atom/json, NULL for email/saved
  ]
);

// ============================================================================
// TAGS
// ============================================================================

/**
 * Tags table - user-defined tags for organizing subscriptions.
 * Each tag belongs to a single user.
 */
export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"), // hex color for UI (e.g., "#ff6b6b")

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Each user can only have one tag with a given name
    unique("uq_tags_user_name").on(table.userId, table.name),
    // Index for listing tags by user
    index("idx_tags_user").on(table.userId),
  ]
);

/**
 * Subscription tags junction table - links subscriptions to tags.
 * Enables many-to-many relationship between subscriptions and tags.
 */
export const subscriptionTags = pgTable(
  "subscription_tags",
  {
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.subscriptionId, table.tagId] }),
    // Index for finding all subscriptions with a given tag
    index("idx_subscription_tags_tag").on(table.tagId),
  ]
);

// ============================================================================
// USER SUBSCRIPTIONS
// ============================================================================

/**
 * Subscriptions table - user subscriptions to feeds.
 * Soft delete via unsubscribedAt.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    feedId: uuid("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),

    customTitle: text("custom_title"), // user's override for feed title

    subscribedAt: timestamp("subscribed_at", { withTimezone: true }).notNull().defaultNow(), // critical for visibility
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }), // soft delete

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Unique constraint on user + feed
    unique("uq_subscriptions_user_feed").on(table.userId, table.feedId),
    index("idx_subscriptions_user").on(table.userId),
    index("idx_subscriptions_feed").on(table.feedId),
  ]
);

// ============================================================================
// USER ENTRIES (visibility + state)
// ============================================================================

/**
 * User entries - tracks which entries are visible to each user and their read/starred state.
 *
 * Row existence means the entry is visible to the user. Rows are created:
 * 1. When a feed is fetched - for all active subscribers
 * 2. When a user subscribes - for entries currently in the live feed
 *
 * This replaces the old fetchedAt >= subscribedAt visibility logic with explicit tracking,
 * ensuring users only see entries that were in the feed when they subscribed or
 * that were added while they were subscribed.
 *
 * Uses composite primary key (user_id, entry_id).
 */
export const userEntries = pgTable(
  "user_entries",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),

    read: boolean("read").notNull().default(false),
    starred: boolean("starred").notNull().default(false),

    readAt: timestamp("read_at", { withTimezone: true }),
    starredAt: timestamp("starred_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.entryId] }),
    // For finding unread entries quickly
    index("idx_user_entries_unread").on(table.userId, table.entryId),
    // For starred entries view
    index("idx_user_entries_starred").on(table.userId, table.starredAt),
  ]
);

// ============================================================================
// JOB QUEUE
// See docs/job-queue-design.md for detailed documentation.
// ============================================================================

/**
 * Jobs table - Postgres-based job queue for background processing.
 *
 * One job per scheduled task (e.g., one per feed for fetch_feed jobs).
 * Jobs are persistent and reused across runs, not created/completed per execution.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    type: text("type").notNull(), // 'fetch_feed', 'renew_websub'
    payload: text("payload").notNull().default("{}"), // JSON payload

    // Scheduling state
    enabled: boolean("enabled").notNull().default(true),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    runningSince: timestamp("running_since", { withTimezone: true }), // NULL = not running

    // Tracking
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Index for polling: enabled jobs that are due
    index("idx_jobs_polling").on(table.nextRunAt),
    // Index for looking up feed jobs by feedId
    index("idx_jobs_feed_id").on(sql`(${table.payload}->>'feedId')`),
  ]
);

// ============================================================================
// WEBSUB SUBSCRIPTIONS
// ============================================================================

/**
 * WebSub subscriptions table - tracks push notification subscriptions.
 * Enables real-time feed updates via WebSub/PubSubHubbub protocol.
 */
export const websubSubscriptions = pgTable(
  "websub_subscriptions",
  {
    id: uuid("id").primaryKey(),
    feedId: uuid("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),

    hubUrl: text("hub_url").notNull(), // WebSub hub URL
    topicUrl: text("topic_url").notNull(), // Feed URL (topic)
    callbackSecret: text("callback_secret").notNull(), // HMAC secret for verification

    state: websubStateEnum("state").notNull().default("pending"),
    leaseSeconds: integer("lease_seconds"), // Subscription lease duration
    expiresAt: timestamp("expires_at", { withTimezone: true }), // When subscription expires

    lastChallengeAt: timestamp("last_challenge_at", { withTimezone: true }), // Last verification attempt
    lastError: text("last_error"), // Last error message if any

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Unique constraint on feed + hub to prevent duplicate subscriptions
    unique("uq_websub_subscriptions_feed_hub").on(table.feedId, table.hubUrl),
    // Index for finding expiring subscriptions that need renewal
    index("idx_websub_expiring").on(table.expiresAt),
    // Index for finding subscriptions by feed
    index("idx_websub_feed").on(table.feedId),
  ]
);

// ============================================================================
// NARRATION
// ============================================================================

/**
 * Narration content table - stores LLM-processed text for text-to-speech.
 * Keyed by content hash for deduplication across entries and saved articles.
 */
export const narrationContent = pgTable(
  "narration_content",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    contentHash: text("content_hash").unique().notNull(), // SHA256 of source content

    contentNarration: text("content_narration"), // null until generated
    generatedAt: timestamp("generated_at", { withTimezone: true }),

    // Paragraph mapping for narration highlighting
    // Maps narration paragraph indices to original HTML paragraph indices
    // Format: [{ n: 0, o: [0] }, { n: 1, o: [1, 2] }, ...]
    paragraphMap: jsonb("paragraph_map").$type<ParagraphMapping[] | null>(),

    // Error tracking for retry logic
    error: text("error"),
    errorAt: timestamp("error_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Index for finding narration that needs generation (null narration, no recent error)
    index("idx_narration_needs_generation").on(table.id),
  ]
);

// ============================================================================
// EMAIL SUBSCRIPTIONS
// ============================================================================

/**
 * Ingest addresses table - unique email addresses for receiving newsletters.
 * Each user can have multiple ingest addresses (up to 5, enforced in application).
 * Email format: {token}@ingest.lionreader.com
 */
export const ingestAddresses = pgTable(
  "ingest_addresses",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    token: text("token").unique().notNull(), // Random token for the email address
    label: text("label"), // User-provided name for the address

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // Soft delete, rejects future emails
  },
  (table) => [
    // For listing addresses by user
    index("idx_ingest_addresses_user").on(table.userId),
    // For looking up by token during email processing
    index("idx_ingest_addresses_token").on(table.token),
  ]
);

/**
 * Blocked senders table - stores senders that the user has blocked.
 * When a user unsubscribes from an email feed, the sender is added here.
 * Future emails from blocked senders are silently dropped.
 */
export const blockedSenders = pgTable(
  "blocked_senders",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    senderEmail: text("sender_email").notNull(), // Normalized sender email (lowercased, plus codes stripped)
    blockedAt: timestamp("blocked_at", { withTimezone: true }).notNull().defaultNow(),

    // Store unsubscribe info for potential retry
    listUnsubscribeMailto: text("list_unsubscribe_mailto"),
    unsubscribeSentAt: timestamp("unsubscribe_sent_at", { withTimezone: true }),
  },
  (table) => [
    // Unique constraint: one block per (user, sender)
    unique("uq_blocked_senders_user_email").on(table.userId, table.senderEmail),
    // For listing blocked senders by user
    index("idx_blocked_senders_user").on(table.userId),
  ]
);

// ============================================================================
// OPML IMPORTS
// ============================================================================

/**
 * Status of an individual feed in an OPML import.
 */
export type OpmlImportFeedStatus = "pending" | "imported" | "skipped" | "failed";

/**
 * Individual feed result in an OPML import.
 */
export interface OpmlImportFeedResult {
  url: string;
  title: string | null;
  status: OpmlImportFeedStatus;
  error?: string;
  feedId?: string;
  subscriptionId?: string;
}

/**
 * Feed data parsed from OPML file.
 */
export interface OpmlImportFeedData {
  xmlUrl: string;
  title?: string;
  htmlUrl?: string;
  category?: string[];
}

/**
 * OPML imports table - tracks asynchronous OPML import jobs.
 * Allows returning immediately to the user while processing feeds in the background.
 */
export const opmlImports = pgTable(
  "opml_imports",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Status: pending (queued), processing (job running), completed (done), failed (job error)
    status: text("status").notNull().default("pending"), // 'pending' | 'processing' | 'completed' | 'failed'

    // Counts
    totalFeeds: integer("total_feeds").notNull(),
    importedCount: integer("imported_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),

    // The parsed OPML feeds to import
    feedsData: jsonb("feeds_data").$type<OpmlImportFeedData[]>().notNull(),

    // Results for each feed (populated as import progresses)
    results: jsonb("results").$type<OpmlImportFeedResult[]>().notNull().default([]),

    // Error message if the job itself failed
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    // For listing imports by user
    index("idx_opml_imports_user").on(table.userId),
    // For finding pending imports
    index("idx_opml_imports_status").on(table.status),
  ]
);

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Feed = typeof feeds.$inferSelect;
export type NewFeed = typeof feeds.$inferInsert;

export type Entry = typeof entries.$inferSelect;
export type NewEntry = typeof entries.$inferInsert;

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

export type UserEntry = typeof userEntries.$inferSelect;
export type NewUserEntry = typeof userEntries.$inferInsert;

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

export type OAuthAccount = typeof oauthAccounts.$inferSelect;
export type NewOAuthAccount = typeof oauthAccounts.$inferInsert;

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;

export type SubscriptionTag = typeof subscriptionTags.$inferSelect;
export type NewSubscriptionTag = typeof subscriptionTags.$inferInsert;

export type WebsubSubscription = typeof websubSubscriptions.$inferSelect;
export type NewWebsubSubscription = typeof websubSubscriptions.$inferInsert;

export type NarrationContent = typeof narrationContent.$inferSelect;
export type NewNarrationContent = typeof narrationContent.$inferInsert;

export type IngestAddress = typeof ingestAddresses.$inferSelect;
export type NewIngestAddress = typeof ingestAddresses.$inferInsert;

export type BlockedSender = typeof blockedSenders.$inferSelect;
export type NewBlockedSender = typeof blockedSenders.$inferInsert;

export type OpmlImport = typeof opmlImports.$inferSelect;
export type NewOpmlImport = typeof opmlImports.$inferInsert;
