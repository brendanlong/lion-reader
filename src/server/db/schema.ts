import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  pgView,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ============================================================================
// ENUMS
// ============================================================================

export const feedTypeEnum = pgEnum("feed_type", ["web", "email", "saved"]);

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
  algorithmicFeedEnabled: boolean("algorithmic_feed_enabled").notNull().default(true), // Enable algorithmic feed, voting, and model training

  // User-configured API keys (override server defaults when set)
  groqApiKey: text("groq_api_key"), // For narration LLM preprocessing
  anthropicApiKey: text("anthropic_api_key"), // For AI summarization
  summarizationModel: text("summarization_model"), // Anthropic model for summaries
  summarizationMaxWords: integer("summarization_max_words"), // Override SUMMARIZATION_MAX_WORDS
  summarizationPrompt: text("summarization_prompt"), // Custom summarization prompt

  // Best feed sorting weights: sort by score_weight * predicted_score + uncertainty_weight * (1 - confidence)
  bestFeedScoreWeight: real("best_feed_score_weight").notNull().default(1),
  bestFeedUncertaintyWeight: real("best_feed_uncertainty_weight").notNull().default(1),

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

/**
 * API tokens table - for extension and third-party integrations.
 * Tokens are scoped to specific permissions (e.g., 'saved:write' for saving articles).
 * Token is stored as SHA-256 hash (never raw), similar to sessions.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").unique().notNull(), // SHA-256 of API token

    // Scopes define what this token can do (e.g., ['saved:write'])
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'`),

    // Optional name for user to identify the token
    name: text("name"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_api_tokens_user").on(table.userId),
    index("idx_api_tokens_token").on(table.tokenHash),
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

    // OAuth scopes granted by user (for incremental authorization)
    scopes: text("scopes").array(),

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
// OAUTH 2.1 AUTHORIZATION SERVER
// ============================================================================

/**
 * OAuth clients table - registered OAuth 2.1 clients.
 * Supports both pre-registered clients and Client ID Metadata Documents (CIMD).
 */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: uuid("id").primaryKey(),
    clientId: text("client_id").unique().notNull(), // URL for CIMD, or custom ID
    clientSecretHash: text("client_secret_hash"), // NULL for public clients
    name: text("name").notNull(),
    redirectUris: text("redirect_uris").array().notNull(), // Allowed redirect URIs
    grantTypes: text("grant_types")
      .array()
      .notNull()
      .default(sql`'{authorization_code,refresh_token}'`),
    scopes: text("scopes").array(), // Available scopes for this client
    isPublic: boolean("is_public").notNull().default(true), // PKCE required for public clients
    metadataUrl: text("metadata_url"), // For Client ID Metadata Documents
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_oauth_clients_client_id").on(table.clientId)]
);

/**
 * OAuth authorization codes table - short-lived codes for OAuth flow.
 * Codes are single-use and expire after ~10 minutes.
 * PKCE with S256 is required.
 */
export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    id: uuid("id").primaryKey(),
    codeHash: text("code_hash").unique().notNull(), // SHA-256 hash of code
    clientId: text("client_id").notNull(), // References oauth_clients.client_id
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    scopes: text("scopes").array().notNull(),
    codeChallenge: text("code_challenge").notNull(), // PKCE S256 hash
    codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
    resource: text("resource"), // RFC 8707 resource indicator
    state: text("state"), // Client-provided state for CSRF
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_oauth_auth_codes_code").on(table.codeHash),
    index("idx_oauth_auth_codes_user").on(table.userId),
    index("idx_oauth_auth_codes_expires").on(table.expiresAt),
    check("oauth_auth_codes_pkce_s256", sql`${table.codeChallengeMethod} = 'S256'`),
  ]
);

/**
 * OAuth access tokens table - short-lived tokens (~1 hour).
 * Used to authenticate API requests.
 */
export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: uuid("id").primaryKey(),
    tokenHash: text("token_hash").unique().notNull(), // SHA-256 hash of token
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().notNull(),
    resource: text("resource"), // RFC 8707 audience
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_oauth_access_tokens_token").on(table.tokenHash),
    index("idx_oauth_access_tokens_user").on(table.userId),
    index("idx_oauth_access_tokens_client").on(table.clientId),
    index("idx_oauth_access_tokens_expires").on(table.expiresAt),
  ]
);

/**
 * OAuth refresh tokens table - longer-lived tokens (~30 days).
 * Supports token rotation for security.
 */
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: uuid("id").primaryKey(),
    tokenHash: text("token_hash").unique().notNull(), // SHA-256 hash of token
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().notNull(),
    accessTokenId: uuid("access_token_id").references(() => oauthAccessTokens.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedById: uuid("replaced_by_id"), // Token rotation chain (self-reference added manually)
  },
  (table) => [
    index("idx_oauth_refresh_tokens_token").on(table.tokenHash),
    index("idx_oauth_refresh_tokens_user").on(table.userId),
    index("idx_oauth_refresh_tokens_client").on(table.clientId),
    index("idx_oauth_refresh_tokens_expires").on(table.expiresAt),
    index("idx_oauth_refresh_tokens_access").on(table.accessTokenId),
  ]
);

/**
 * OAuth consent grants table - tracks user consent for clients.
 * Avoids re-prompting users who have already authorized a client.
 */
export const oauthConsentGrants = pgTable(
  "oauth_consent_grants",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    scopes: text("scopes").array().notNull(), // Approved scopes
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique("uq_oauth_consent_user_client").on(table.userId, table.clientId),
    index("idx_oauth_consent_grants_user").on(table.userId),
    index("idx_oauth_consent_grants_client").on(table.clientId),
  ]
);

// ============================================================================
// FEEDS (shared canonical data)
// ============================================================================

/**
 * Feeds table - stores canonical feed data shared across users.
 * For email feeds (type='email'), the feed is user-specific and uses email_sender_pattern.
 * For URL-based feeds (type='web'), feeds are shared across users.
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
    bodyHash: text("body_hash"), // SHA-256 hash of raw feed body for change detection
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    // Timestamp when entries last changed (new, updated, or removed from feed)
    // This matches entries.lastSeenAt for entries currently in the feed
    lastEntriesUpdatedAt: timestamp("last_entries_updated_at", { withTimezone: true }),
    nextFetchAt: timestamp("next_fetch_at", { withTimezone: true }),

    // Error tracking
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastError: text("last_error"),

    // WebSub support
    hubUrl: text("hub_url"), // WebSub hub URL discovered from feed
    selfUrl: text("self_url"), // Canonical feed URL (topic URL)
    websubActive: boolean("websub_active").notNull().default(false), // Whether WebSub is currently active

    // Fetch statistics
    lastFetchEntryCount: integer("last_fetch_entry_count"), // Number of entries in the last successful fetch
    lastFetchSizeBytes: integer("last_fetch_size_bytes"), // Size of HTTP response body in bytes

    // Redirect tracking - wait period before applying permanent redirects
    redirectUrl: text("redirect_url"), // URL we're being redirected to (301/308)
    redirectFirstSeenAt: timestamp("redirect_first_seen_at", { withTimezone: true }), // When redirect was first observed

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
    // - web: <guid> or <id> from feed
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
    // Last time this entry was seen in a feed fetch (web only, NULL for email/saved)
    // Used to determine visibility: entry.lastSeenAt = feed.lastFetchedAt means it's in the current feed
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),

    // Version tracking
    contentHash: text("content_hash").notNull(), // for detecting updates

    // Full content fetching (on-demand from URL)
    fullContentHash: text("full_content_hash"), // SHA256 of full content (for separate summary caching)
    fullContentOriginal: text("full_content_original"), // Raw HTML from URL
    fullContentCleaned: text("full_content_cleaned"), // Readability-cleaned HTML
    fullContentFetchedAt: timestamp("full_content_fetched_at", { withTimezone: true }),
    fullContentError: text("full_content_error"), // Error message if fetch failed

    // Spam tracking (for email entries)
    spamScore: real("spam_score"), // Provider's spam score
    isSpam: boolean("is_spam").notNull().default(false), // Provider's spam verdict

    // List-Unsubscribe info (for email entries, used when unsubscribing)
    listUnsubscribeMailto: text("list_unsubscribe_mailto"), // mailto: URL from header
    listUnsubscribeHttps: text("list_unsubscribe_https"), // https: URL from header
    listUnsubscribePost: boolean("list_unsubscribe_post"), // true if one-click POST supported

    // Unsubscribe URL extracted from email HTML body (for email entries)
    unsubscribeUrl: text("unsubscribe_url"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

    // Wallabag API integer ID - Postgres generated column from SHA-256 of UUID
    // Matches TypeScript uuidToWallabagId() in src/server/wallabag/format.ts
    wallabagId: integer("wallabag_id").generatedAlwaysAs(
      sql`(('x' || left(encode(sha256(id::text::bytea), 'hex'), 8))::bit(32)::int & x'7fffffff'::int)`
    ),
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
    // - entries_last_seen_only_fetched: last_seen_at required for web feeds, NULL for email/saved
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // Soft delete for sync tracking
  },
  (table) => [
    // Each user can only have one tag with a given name
    unique("uq_tags_user_name").on(table.userId, table.name),
    // Index for listing tags by user
    index("idx_tags_user").on(table.userId),
    // Index for sync queries
    index("idx_tags_updated_at").on(table.userId, table.updatedAt),
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

    // Previous feed IDs from redirect migrations - preserves history when feeds redirect
    previousFeedIds: uuid("previous_feed_ids").array().notNull().default([]),
    // Generated column combining feedId with previousFeedIds for efficient querying
    // Use s.feed_ids @> ARRAY[e.feed_id] to match entries from current or previous feeds (uses GIN index)
    feedIds: uuid("feed_ids")
      .array()
      .notNull()
      .generatedAlwaysAs(sql`ARRAY[feed_id] || previous_feed_ids`),

    customTitle: text("custom_title"), // user's override for feed title
    fetchFullContent: boolean("fetch_full_content").notNull().default(false), // fetch full article from URL

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
    // GIN index on feed_ids for efficient @> (array contains) lookups
    index("idx_subscriptions_feed_ids").using("gin", table.feedIds),
    // GIN index on previous_feed_ids for efficient @> lookups in redirect deduplication
    index("idx_subscriptions_previous_feed_ids").using("gin", table.previousFeedIds),
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

    // Explicit score: user-voted score (-2 to +2), null means no vote
    score: smallint("score"),
    scoreChangedAt: timestamp("score_changed_at", { withTimezone: true }),

    // Implicit signal flags - track user actions that imply interest/disinterest
    // Priority for implicit score: starred (+2) > unread (+1) > read-on-list (-1) > default (0)
    hasMarkedReadOnList: boolean("has_marked_read_on_list").notNull().default(false),
    hasMarkedUnread: boolean("has_marked_unread").notNull().default(false),
    hasStarred: boolean("has_starred").notNull().default(false),

    // Timestamps for idempotent updates - tracks when each field was last set
    // Used for conditional updates: only apply if incoming timestamp is newer
    readChangedAt: timestamp("read_changed_at", { withTimezone: true }).notNull().defaultNow(),
    starredChangedAt: timestamp("starred_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // Timestamp for tracking state changes (for sync endpoint)
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.entryId] }),
    // For joins from entries table
    index("idx_user_entries_entry_id").on(table.entryId),
    // Partial indexes defined in migration (can't express WHERE clause in drizzle)
  ]
);

// ============================================================================
// DATABASE VIEWS
// These views simplify queries by abstracting common joins and visibility rules
// ============================================================================

/**
 * user_feeds view - Active subscriptions with feed metadata merged.
 * Uses subscription.id as the primary key, hiding the internal feedId from clients.
 *
 * Note: This view is defined in migration 0035_subscription_views.sql.
 * The Drizzle definition here allows type-safe queries against the view.
 */
export const userFeeds = pgView("user_feeds", {
  id: uuid("id").notNull(),
  userId: uuid("user_id").notNull(),
  subscribedAt: timestamp("subscribed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), // for sync cursor tracking
  feedId: uuid("feed_id").notNull(), // internal use only
  feedIds: uuid("feed_ids").array().notNull(), // for entry visibility queries
  customTitle: text("custom_title"),
  fetchFullContent: boolean("fetch_full_content").notNull(), // fetch full article from URL
  type: feedTypeEnum("type").notNull(),
  title: text("title"), // resolved title (custom or original)
  originalTitle: text("original_title"), // feed's original title for rename UI
  url: text("url"),
  siteUrl: text("site_url"),
  description: text("description"),
}).existing();

/**
 * visible_entries view - Entries with visibility rules and subscription context.
 * An entry is visible if:
 * 1. User has a user_entries row for it, AND
 * 2. Either the entry is from an active subscription, OR the entry is starred
 *
 * Note: This view is defined in migration 0035_subscription_views.sql.
 * The Drizzle definition here allows type-safe queries against the view.
 */
export const visibleEntries = pgView("visible_entries", {
  userId: uuid("user_id").notNull(),
  id: uuid("id").notNull(),
  feedId: uuid("feed_id").notNull(),
  type: feedTypeEnum("type").notNull(),
  guid: text("guid").notNull(),
  url: text("url"),
  title: text("title"),
  author: text("author"),
  contentOriginal: text("content_original"),
  contentCleaned: text("content_cleaned"),
  summary: text("summary"),
  siteName: text("site_name"),
  imageUrl: text("image_url"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  contentHash: text("content_hash").notNull(),
  fullContentHash: text("full_content_hash"),
  spamScore: real("spam_score"),
  isSpam: boolean("is_spam").notNull(),
  listUnsubscribeMailto: text("list_unsubscribe_mailto"),
  listUnsubscribeHttps: text("list_unsubscribe_https"),
  listUnsubscribePost: boolean("list_unsubscribe_post"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  fullContentOriginal: text("full_content_original"),
  fullContentCleaned: text("full_content_cleaned"),
  fullContentFetchedAt: timestamp("full_content_fetched_at", { withTimezone: true }),
  fullContentError: text("full_content_error"),
  read: boolean("read").notNull(),
  starred: boolean("starred").notNull(),
  score: smallint("score"),
  hasMarkedReadOnList: boolean("has_marked_read_on_list").notNull(),
  hasMarkedUnread: boolean("has_marked_unread").notNull(),
  hasStarred: boolean("has_starred").notNull(),
  subscriptionId: uuid("subscription_id"), // nullable - null for orphaned starred entries
  predictedScore: real("predicted_score"), // ML-predicted score, nullable
  predictionConfidence: real("prediction_confidence"), // confidence of prediction, nullable
  unsubscribeUrl: text("unsubscribe_url"), // extracted from email HTML body
  readChangedAt: timestamp("read_changed_at", { withTimezone: true }).notNull(),
  wallabagId: integer("wallabag_id"), // Wallabag API integer ID (generated column from entries table)
}).existing();

// ============================================================================
// JOB QUEUE
// See docs/job-queue-design.md for detailed documentation.
// ============================================================================

/**
 * Jobs table - Postgres-based job queue for background processing.
 *
 * One job per scheduled task (e.g., one per feed for fetch_feed jobs).
 * Jobs are persistent and reused across runs, not created/completed per execution.
 *
 * Note: Job eligibility is determined by data state (e.g., feeds with active subscribers),
 * not by an enabled flag. The job table tracks scheduling state only.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    type: text("type").notNull(), // 'fetch_feed', 'renew_websub', 'train_score_model'
    payload: jsonb("payload").notNull().default({}).$type<Record<string, unknown>>(),

    // Scheduling state
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
    // Index for polling: jobs that are due
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
    unsubscribeRequestedAt: timestamp("unsubscribe_requested_at", { withTimezone: true }), // When we requested unsubscribe from hub

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
// SCORE PREDICTION
// ============================================================================

/**
 * User score models table - stores trained ML models for score prediction.
 * One model per user, trained on their explicit and implicit scores.
 */
export const userScoreModels = pgTable("user_score_models", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),

  // Serialized model data (Ridge weights as JSON)
  modelData: text("model_data").notNull(),

  // Model metadata for feature extraction
  vocabulary: jsonb("vocabulary").notNull().$type<Record<string, number>>(), // {term: index}
  idfValues: jsonb("idf_values").notNull().$type<number[]>(), // IDF values array
  feedIds: text("feed_ids").array().notNull(), // Feed ID mapping for one-hot encoding

  // Training info
  trainingCount: integer("training_count").notNull(),
  modelVersion: integer("model_version").notNull().default(1),
  trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),

  // Cross-validation metrics (for confidence estimation)
  cvMae: real("cv_mae"), // Mean Absolute Error
  cvCorrelation: real("cv_correlation"), // Pearson correlation

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Entry score predictions table - stores predicted scores for entries.
 * Predictions are generated by the score prediction service using the user's model.
 */
export const entryScorePredictions = pgTable(
  "entry_score_predictions",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),

    // Prediction results
    predictedScore: real("predicted_score").notNull(), // Raw prediction
    confidence: real("confidence").notNull(), // 0 to 1

    // Metadata
    modelVersion: integer("model_version").notNull(),
    predictedAt: timestamp("predicted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.entryId] }),
    index("idx_entry_score_predictions_entry").on(table.entryId),
    index("idx_entry_score_predictions_user_score").on(table.userId, table.predictedScore),
  ]
);

// ============================================================================
// AI SUMMARIZATION
// ============================================================================

/**
 * Entry summaries table - stores AI-generated article summaries.
 * Keyed by (user_id, content_hash) for per-user caching since different
 * users may have different models, max words, or custom prompts.
 */
export const entrySummaries = pgTable(
  "entry_summaries",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(), // SHA256 of source content

    summaryText: text("summary_text"), // null until generated
    modelId: text("model_id"), // e.g., "claude-sonnet-4-20250514"
    promptVersion: integer("prompt_version").notNull().default(1), // for cache invalidation

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    generatedAt: timestamp("generated_at", { withTimezone: true }), // when summary was generated

    // Error tracking for retry logic
    error: text("error"),
    errorAt: timestamp("error_at", { withTimezone: true }),
  },
  (table) => [
    // Index for finding stale summaries
    index("idx_entry_summaries_prompt_version").on(table.promptVersion),
    // Unique constraint for per-user summary caching
    unique("entry_summaries_user_content_unique").on(table.userId, table.contentHash),
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

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;

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

export type EntrySummary = typeof entrySummaries.$inferSelect;
export type NewEntrySummary = typeof entrySummaries.$inferInsert;

export type IngestAddress = typeof ingestAddresses.$inferSelect;
export type NewIngestAddress = typeof ingestAddresses.$inferInsert;

export type BlockedSender = typeof blockedSenders.$inferSelect;
export type NewBlockedSender = typeof blockedSenders.$inferInsert;

export type OpmlImport = typeof opmlImports.$inferSelect;
export type NewOpmlImport = typeof opmlImports.$inferInsert;

export type OAuthClient = typeof oauthClients.$inferSelect;
export type NewOAuthClient = typeof oauthClients.$inferInsert;

export type OAuthAuthorizationCode = typeof oauthAuthorizationCodes.$inferSelect;
export type NewOAuthAuthorizationCode = typeof oauthAuthorizationCodes.$inferInsert;

export type OAuthAccessToken = typeof oauthAccessTokens.$inferSelect;
export type NewOAuthAccessToken = typeof oauthAccessTokens.$inferInsert;

export type OAuthRefreshToken = typeof oauthRefreshTokens.$inferSelect;
export type NewOAuthRefreshToken = typeof oauthRefreshTokens.$inferInsert;

export type OAuthConsentGrant = typeof oauthConsentGrants.$inferSelect;
export type NewOAuthConsentGrant = typeof oauthConsentGrants.$inferInsert;

export type UserScoreModel = typeof userScoreModels.$inferSelect;
export type NewUserScoreModel = typeof userScoreModels.$inferInsert;

export type EntryScorePrediction = typeof entryScorePredictions.$inferSelect;
export type NewEntryScorePrediction = typeof entryScorePredictions.$inferInsert;

// View types
export type UserFeed = typeof userFeeds.$inferSelect;
export type VisibleEntry = typeof visibleEntries.$inferSelect;
