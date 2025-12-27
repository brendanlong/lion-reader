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
