import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// ============================================================================
// ENUMS
// ============================================================================

export const feedTypeEnum = pgEnum("feed_type", ["rss", "atom", "json"]);

export const jobStatusEnum = pgEnum("job_status", ["pending", "running", "completed", "failed"]);

export const websubStateEnum = pgEnum("websub_state", ["pending", "active", "unsubscribed"]);

// ============================================================================
// AUTHENTICATION
// ============================================================================

/**
 * Users table - stores user accounts.
 * Primary key uses UUIDv7 for time-ordering and global uniqueness.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").unique().notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  passwordHash: text("password_hash"), // null if OAuth-only (future)

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
 */
export const feeds = pgTable(
  "feeds",
  {
    id: uuid("id").primaryKey(),
    type: feedTypeEnum("type").notNull(),

    url: text("url").unique(), // For URL-based feeds

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
  (table) => [index("idx_feeds_next_fetch").on(table.nextFetchAt)]
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

    // Identifier from source
    guid: text("guid").notNull(), // from RSS/Atom

    // Content
    url: text("url"),
    title: text("title"),
    author: text("author"),
    contentOriginal: text("content_original"),
    contentCleaned: text("content_cleaned"), // Readability-cleaned HTML
    summary: text("summary"), // truncated for previews

    // Timestamps
    publishedAt: timestamp("published_at", { withTimezone: true }), // from feed (may be null/inaccurate)
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(), // when we first saw it

    // Version tracking
    contentHash: text("content_hash").notNull(), // for detecting updates

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
// USER ENTRY STATE
// ============================================================================

/**
 * User entry states - read/starred status per user per entry.
 * Uses composite primary key (user_id, entry_id).
 */
export const userEntryStates = pgTable(
  "user_entry_states",
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
    index("idx_user_entry_states_unread").on(table.userId, table.entryId),
    // For starred entries view
    index("idx_user_entry_states_starred").on(table.userId, table.starredAt),
  ]
);

// ============================================================================
// JOB QUEUE
// ============================================================================

/**
 * Jobs table - Postgres-based job queue for background processing.
 * Jobs are idempotent and safe to retry.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    type: text("type").notNull(), // 'fetch_feed', 'cleanup', etc.
    payload: text("payload").notNull().default("{}"), // JSON payload

    // Scheduling
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    // Status and retries
    status: jobStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_jobs_pending").on(table.scheduledFor),
    index("idx_jobs_status").on(table.status),
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
// SAVED ARTICLES (Read-it-Later)
// ============================================================================

/**
 * Saved articles table - stores URLs saved for later reading.
 * Similar to Pocket/Instapaper - articles have read/starred state like feed entries.
 */
export const savedArticles = pgTable(
  "saved_articles",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    url: text("url").notNull(),
    title: text("title"),
    siteName: text("site_name"),
    author: text("author"),
    imageUrl: text("image_url"), // og:image for display

    contentOriginal: text("content_original"),
    contentCleaned: text("content_cleaned"), // via Readability
    excerpt: text("excerpt"),
    contentHash: text("content_hash"), // SHA256 hash for narration deduplication

    // Same read/starred model as entries
    read: boolean("read").notNull().default(false),
    readAt: timestamp("read_at", { withTimezone: true }),
    starred: boolean("starred").notNull().default(false),
    starredAt: timestamp("starred_at", { withTimezone: true }),

    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Can only save same URL once per user
    unique("uq_saved_articles_user_url").on(table.userId, table.url),
    // For listing saved articles by user (UUIDv7 gives time ordering with DESC)
    index("idx_saved_articles_user").on(table.userId, table.id),
    // For filtering unread articles
    index("idx_saved_articles_unread").on(table.userId),
    // For filtering starred articles
    index("idx_saved_articles_starred").on(table.userId, table.starredAt),
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
// TYPE EXPORTS
// ============================================================================

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

export type UserEntryState = typeof userEntryStates.$inferSelect;
export type NewUserEntryState = typeof userEntryStates.$inferInsert;

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

export type SavedArticle = typeof savedArticles.$inferSelect;
export type NewSavedArticle = typeof savedArticles.$inferInsert;

export type NarrationContent = typeof narrationContent.$inferSelect;
export type NewNarrationContent = typeof narrationContent.$inferInsert;
