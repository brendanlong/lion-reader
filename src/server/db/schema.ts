import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  doublePrecision,
  integer,
  pgEnum,
  pgTable,
  pgView,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ParagraphMapEntry } from "@/lib/narration/paragraph-map";
import { replaceNul } from "./nul";
import { temporalTimestamp } from "./temporal";
import { SUBSCRIPTION_TYPES, type EntryType } from "@/lib/entry-types";

/**
 * Postgres citext (case-insensitive text). Behaves as a plain string in
 * TypeScript; the case-insensitive comparison semantics live in the database.
 */
const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

/**
 * Postgres `tsvector` (full-text search document). Only used as the type of the
 * stored `entries.search_vector` column exposed through `visible_entries`;
 * searchEntries references it in raw `@@` / `ts_rank` SQL, never selecting the
 * value itself, so the string `data` type is just a placeholder for Drizzle.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * `jsonb` with NUL replaced in string values (`replaceNul`): once
 * stringified, a NUL is a JSON escape that `jsonb` rejects and that
 * `NulSafeClient` can't tell apart from the same text in a `text` column.
 * Object keys aren't rewritten; ours are fixed.
 */
const nulSafeJsonb = customType<{ data: unknown; driverData: string }>({
  dataType() {
    return "jsonb";
  },
  toDriver(value) {
    return JSON.stringify(value, (_key, nested: unknown) =>
      typeof nested === "string" ? replaceNul(nested) : nested
    );
  },
  // Same as Drizzle's: pg already parses jsonb, so a string is a fallback.
  fromDriver(value) {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  },
});

// ============================================================================
// ENUMS
// ============================================================================

const feedTypeEnum = pgEnum("feed_type", SUBSCRIPTION_TYPES);

export type FeedType = (typeof feedTypeEnum.enumValues)[number];

const websubStateEnum = pgEnum("websub_state", ["pending", "active", "unsubscribed"]);

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
    usedByUserId: uuid("used_by_user_id").references((): AnyPgColumn => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_invites_expires").on(table.expiresAt)]
);

/**
 * Users table - stores user accounts.
 * Primary key uses UUIDv7 for time-ordering and global uniqueness.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: citext("email").unique().notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    passwordHash: text("password_hash"), // null if OAuth-only (future)
    inviteId: uuid("invite_id").references(() => invites.id, { onDelete: "set null" }),

    // Preferences
    showSpam: boolean("show_spam").notNull().default(false), // Show spam entries from email feeds

    // AI settings (API keys are in user_api_keys)
    summarizationModel: text("summarization_model"), // provider:model ref for summaries (legacy: bare Anthropic ID)
    summarizationMaxWords: integer("summarization_max_words"), // Override SUMMARIZATION_MAX_WORDS
    summarizationPrompt: text("summarization_prompt"), // Custom summarization prompt
    narrationModel: text("narration_model"), // provider:model ref for narration preprocessing (JSON-mode providers)

    // Signup confirmation: each records when the user accepted the agreement
    tosAgreedAt: timestamp("tos_agreed_at", { withTimezone: true }),
    privacyPolicyAgreedAt: timestamp("privacy_policy_agreed_at", { withTimezone: true }),
    notEuAgreedAt: timestamp("not_eu_agreed_at", { withTimezone: true }),

    // Denormalized most-recent activity timestamp (updated fire-and-forget on
    // session validation, see updateLastActiveAt). Kept on the user row so the
    // admin "last active" view survives session retention cleanup, which deletes
    // expired sessions (the previous MAX(sessions.last_active_at) source).
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),

    // Trigger-maintained unread counters (spam excluded; rules in migration
    // 0133, kept by `apply_unread_memberships` / `recompute_list_counters`):
    // starred = starred unread articles; uncategorized = distinct unread
    // articles in untagged active subscriptions other than saved; all =
    // visible unread articles. Saved is the saved subscription's count.
    starredUnreadCount: integer("starred_unread_count").notNull().default(0),
    uncategorizedUnreadCount: integer("uncategorized_unread_count").notNull().default(0),
    allUnreadCount: integer("all_unread_count").notNull().default(0),

    // Opaque Google Reader user id / userProfileId (issue #1117, migration 0097).
    // Drawn from the shared greader_id_seq; DB-assigned via a sequence default, so
    // inserts omit it. Never reversed, so no index.
    greaderUserId: bigint("greader_user_id", { mode: "bigint" })
      .notNull()
      .default(sql`nextval('greader_id_seq'::regclass)`),

    // When the Getting Started saved article was inserted for this user (issue
    // #1397). Set once and never cleared, so unstarring or deleting the article
    // doesn't bring it back.
    gettingStartedAt: timestamp("getting_started_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Supports the admin user list "most recent activity" sort + keyset cursor.
    index("idx_users_last_active_at").on(table.lastActiveAt.desc().nullsLast(), table.id.desc()),
    // Drives the backfill_getting_started job's "who still needs one" scan.
    // Partial, so it drains to empty once every user has been covered.
    index("idx_users_getting_started_pending")
      .on(table.id)
      .where(sql`getting_started_at IS NULL`),
  ]
);

/**
 * A user's own API key for an AI provider (see `@/lib/ai/providers`), which
 * overrides the server's. Encrypted with `encryptApiKey`; never cached.
 */
export const userApiKeys = pgTable(
  "user_api_keys",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    encryptedKey: text("encrypted_key").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.provider] })]
);

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

    // Scopes restricting this session. NULL = full access (a normal browser
    // login). A non-NULL array marks a restricted session (e.g. the Google
    // Reader compat API mints one with ['reader:full-access']); validateSession
    // rejects such sessions for full-access use unless the caller opts in.
    scopes: text("scopes").array(),

    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_sessions_user").on(table.userId)]
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
  (table) => [index("idx_api_tokens_user").on(table.userId)]
);

// ============================================================================
// DISCORD API-TOKEN LINKS
// ============================================================================

/**
 * Discord bot account links created via `/link` with an API token.
 *
 * Maps a Discord user id to the api_tokens row they linked. Lives in Postgres
 * (not Redis) so it survives the deploy-time cache clear and any Redis data
 * loss (#1370). References the token row (ON DELETE CASCADE) rather than the raw
 * token, so no secret is kept at rest and the link auto-invalidates when the
 * token is deleted; revocation/expiry is checked at resolve time. OAuth-based
 * links live in `oauthAccounts` instead. One link per Discord user.
 */
export const discordApiTokenLinks = pgTable(
  "discord_api_token_links",
  {
    discordId: text("discord_id").primaryKey(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_discord_api_token_links_token").on(table.tokenId)]
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
    // One link per provider per user; also serves lookups by user
    unique("uq_oauth_accounts_user_provider").on(table.userId, table.provider),
  ]
);

// ============================================================================
// OAUTH 2.1 AUTHORIZATION SERVER
// ============================================================================

/**
 * OAuth clients table - registered OAuth 2.1 clients.
 * Supports both pre-registered clients and Client ID Metadata Documents (CIMD).
 */
export const oauthClients = pgTable("oauth_clients", {
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    index("idx_oauth_auth_codes_user").on(table.userId),
    index("idx_oauth_auth_codes_expires").on(table.expiresAt),
    check("oauth_auth_codes_pkce_s256", sql`${table.codeChallengeMethod} = 'S256'`),
  ]
);

/**
 * One authorization: an authorization-code exchange or a Wallabag password
 * grant. Every token minted from it, across rotations, belongs to it with
 * ON DELETE CASCADE, and it belongs to its consent grant the same way, so
 * revoking is deleting the grant (or the consent) and the whole chain goes.
 */
export const oauthTokenGrants = pgTable(
  "oauth_token_grants",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Null only for the Wallabag password grant, which has no consent screen.
    consentGrantId: uuid("consent_grant_id").references(() => oauthConsentGrants.id, {
      onDelete: "cascade",
    }),
    clientId: text("client_id").notNull(),
    scopes: text("scopes").array().notNull(),
    resource: text("resource"), // RFC 8707 audience
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_oauth_token_grants_user_client").on(table.userId, table.clientId),
    index("idx_oauth_token_grants_consent").on(table.consentGrantId),
    check(
      "oauth_token_grants_consent_unless_wallabag",
      sql`${table.consentGrantId} IS NOT NULL OR ${table.clientId} = 'wallabag'`
    ),
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
    grantId: uuid("grant_id")
      .notNull()
      .references(() => oauthTokenGrants.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_oauth_access_tokens_user").on(table.userId),
    index("idx_oauth_access_tokens_client").on(table.clientId),
    index("idx_oauth_access_tokens_expires").on(table.expiresAt),
    index("idx_oauth_access_tokens_grant").on(table.grantId),
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
    grantId: uuid("grant_id")
      .notNull()
      .references(() => oauthTokenGrants.id, { onDelete: "cascade" }),
    accessTokenId: uuid("access_token_id").references(() => oauthAccessTokens.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_oauth_refresh_tokens_user").on(table.userId),
    index("idx_oauth_refresh_tokens_client").on(table.clientId),
    index("idx_oauth_refresh_tokens_expires").on(table.expiresAt),
    index("idx_oauth_refresh_tokens_access").on(table.accessTokenId),
    index("idx_oauth_refresh_tokens_grant").on(table.grantId),
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
  },
  (table) => [
    unique("uq_oauth_consent_user_client").on(table.userId, table.clientId),
    index("idx_oauth_consent_grants_client").on(table.clientId),
  ]
);

// ============================================================================
// FEEDS (shared canonical data)
// ============================================================================

/**
 * Feeds table - web feeds' canonical data and fetch state, shared by every
 * subscriber (#1846: only web subscriptions have a feed).
 */
export const feeds = pgTable(
  "feeds",
  {
    id: uuid("id").primaryKey(),
    url: text("url").unique(),

    // Metadata from feed
    title: text("title"),
    description: text("description"),
    siteUrl: text("site_url"),

    // Fetch state
    etag: text("etag"),
    lastModifiedHeader: text("last_modified_header"),
    bodyHash: text("body_hash"), // SHA-256 hash of raw feed body for change detection
    // Database clock (`databaseNow`): compared with entries.pushed_at.
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    // The last poll that changed the feed's current entries (new, updated,
    // removed, or seen again). entries.last_seen_at matches it for entries
    // currently in the feed.
    lastEntriesUpdatedAt: timestamp("last_entries_updated_at", { withTimezone: true }),
    // Informational copy of the schedule for display surfaces (feed stats,
    // broken feeds, admin). The authoritative value is jobs.next_run_at —
    // job claiming never reads this column, and the two can drift.
    nextFetchAt: timestamp("next_fetch_at", { withTimezone: true }),
    // When the last poll's entries stop counting as current for a new
    // subscriber: the next poll by the feed's own cadence, ignoring the WebSub
    // backup interval (`NextFetchResult.staleAt`, `shouldRefetchOnSubscribe`).
    staleAt: timestamp("stale_at", { withTimezone: true }),
    // Scheduling hints the feed declares (RSS <ttl>, sy:updatePeriod/Frequency),
    // kept so fetches that skip parsing (304, unchanged body) still honor them.
    ttlMinutes: integer("ttl_minutes"),
    syndicationUpdatePeriod: text("syndication_update_period"),
    syndicationUpdateFrequency: integer("syndication_update_frequency"),

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

    // Google Reader feed stream id (issue #1117, migration 0097). Clients see
    // subscriptions' stream ids, never a feed's, but every feed takes one from
    // the shared greader_id_seq, so the saved subscription could keep its old
    // saved feed's. DB-assigned via a sequence default, so inserts omit it.
    greaderStreamId: bigint("greader_stream_id", { mode: "bigint" })
      .notNull()
      .default(sql`nextval('greader_id_seq'::regclass)`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_feeds_greader_stream_id").on(table.greaderStreamId)]
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
    // The entry's owner (#1846 phase 6), by its type: a web entry's feed
    // (shared by every subscriber), an email's subscription, a saved article's
    // or upload's user. It scopes duplicate detection (a unique (owner, guid)
    // per kind) and cascades deletes; it's never used to list or count
    // (memberships do that). Exactly the owner column for the entry's type is
    // set (`entries_owner_matches_type`).
    ownerFeedId: uuid("owner_feed_id").references(() => feeds.id, { onDelete: "cascade" }),
    type: feedTypeEnum("type").$type<EntryType>().notNull(), // Denormalized from feed for type-specific constraints and queries

    ownerSubscriptionId: uuid("owner_subscription_id").references(() => subscriptions.id, {
      onDelete: "cascade",
    }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),

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
    // The last poll that saw this entry in the feed (web only). NULL for
    // email/saved, and for a web entry a WebSub push inserted that no poll has
    // seen yet. Decides whether the entry is current for a new subscriber
    // (`currentEntryIdsSql`, "Entry Visibility" in src/server/CLAUDE.md).
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    // The last WebSub push that announced this entry (web only, database
    // clock). Keeps it current until the next poll (`currentEntryIdsSql`).
    pushedAt: timestamp("pushed_at", { withTimezone: true }),

    // Version tracking
    contentHash: text("content_hash").notNull(), // for detecting updates

    // Full content fetching (on-demand from URL)
    fullContentHash: text("full_content_hash"), // SHA256 of full content (for separate summary caching)
    // The fetched page. Only fetches from before #2115 stored it here; it's
    // archived to object storage instead (services/full-content-archive.ts).
    fullContentOriginal: text("full_content_original"),
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

    // Google Reader / Wallabag item ID - global bigint serial. The DB assigns
    // it from a sequence default, so inserts omit it (the .default tells
    // Drizzle it's optional-on-insert). Item ids are stored, not derived from
    // the UUID; see src/server/google-reader/id.ts and
    // src/server/wallabag/id.ts.
    greaderItemId: bigint("greader_item_id", { mode: "bigint" })
      .notNull()
      .default(sql`nextval('entries_greader_item_id_seq'::regclass)`),

    // True for a saved-article *placeholder*: a stand-in entry (URL as title,
    // failure reason as body) the Wallabag POST surface writes when an article
    // can't be fetched (#1254). Lets saveArticle always refetch a placeholder on
    // re-save so a transiently-failed URL self-heals into real content, while a
    // real saved article keeps returning instantly (#1256). Cleared by any
    // successful real save.
    isPlaceholder: boolean("is_placeholder").notNull().default(false),
  },
  (table) => [
    // Unique constraint on owner feed + guid
    unique("uq_entries_owner_feed_guid").on(table.ownerFeedId, table.guid),
    // For listing entries by feed, ordered by time (UUIDv7 is time-ordered)
    index("idx_entries_owner_feed").on(table.ownerFeedId, table.id),
    // For finding entries by fetched time (visibility filtering)
    index("idx_entries_owner_feed_fetched").on(table.ownerFeedId, table.fetchedAt),
    // No query filters on is_spam here, but nearly every row shares its key
    // with its neighbours, so B-tree deduplication makes this a fraction of
    // idx_entries_owner_feed's size, and the planner picks it for plain
    // owner_feed_id lookups (most of this table's index scans in production).
    // Keep it.
    index("idx_entries_owner_feed_spam").on(table.ownerFeedId, table.isSpam),
    // For filtering by entry type
    index("idx_entries_type").on(table.type),
    // sync.events / Wallabag delta: seek changed entries within a feed
    // (owner_feed_id = <subscribed/saved feed> AND updated_at >= cursor). Backs
    // the entry-side arm of the sync.events UNION rewrite (#1105). Migration 0094.
    index("idx_entries_owner_feed_updated_at").on(table.ownerFeedId, table.updatedAt),
    // Unique global Google Reader item id; backs the greader_item_id -> UUID
    // reverse lookup (greaderItemIdsToUuids) with an index seek.
    uniqueIndex("idx_entries_greader_item_id").on(table.greaderItemId),
    // Email and saved owners (#1846, migration 0137): duplicate detection and
    // delta sync's per-owner seek, partial on the owner being set.
    uniqueIndex("uq_entries_owner_subscription_guid")
      .on(table.ownerSubscriptionId, table.guid)
      .where(sql`owner_subscription_id IS NOT NULL`),
    uniqueIndex("uq_entries_owner_user_guid")
      .on(table.ownerUserId, table.guid)
      .where(sql`owner_user_id IS NOT NULL`),
    index("idx_entries_owner_subscription_updated_at")
      .on(table.ownerSubscriptionId, table.updatedAt)
      .where(sql`owner_subscription_id IS NOT NULL`),
    index("idx_entries_owner_user_updated_at")
      .on(table.ownerUserId, table.updatedAt)
      .where(sql`owner_user_id IS NOT NULL`),
    // The pushed arm of currentEntryIdsSql. Partial: only WebSub feeds' entries
    // are ever pushed.
    index("idx_entries_owner_feed_pushed")
      .on(table.ownerFeedId, table.pushedAt)
      .where(sql`type = 'web' AND pushed_at IS NOT NULL`),
    check(
      "entries_owner_matches_type",
      sql`(type = 'web') = (owner_feed_id IS NOT NULL) AND (type = 'email') = (owner_subscription_id IS NOT NULL) AND (type = 'saved') = (owner_user_id IS NOT NULL)`
    ),
    // Expression indexes (Drizzle can't express these, created via raw SQL):
    // - uq_entries_owner_feed_guid_canonical: UNIQUE (owner_feed_id, regexp_replace(guid, '^https?://', 'https://'))
    //   WHERE type = 'web'. Enforces src/server/feed/guid-identity.ts at the DB (#1535). Migration 0109.
    // - idx_entries_web_guid_canonical: (regexp_replace(guid, '^https?://', 'https://')) WHERE type = 'web'
    //   Finds an entry's twins in other feeds for the redirect-merge dedup (#1861). Migration 0125,
    //   with the statistics object entries_guid_canonical_stats on the same expression, without
    //   which the planner doesn't pick it.
    // - idx_entries_published_coalesce: (COALESCE(published_at, fetched_at) DESC, id DESC)
    //   Enables limit pushdown for "all entries" queries. Migration 0060.
    // - idx_entries_owner_feed_published_coalesce: (owner_feed_id, COALESCE(published_at, fetched_at) DESC, id DESC)
    //   Enables seek + limit pushdown for per-feed/subscription queries. Migration 0061.
    //
    // Type-specific check constraints (created via raw SQL in migrations):
    // - entries_spam_only_email: spam fields only for email entries
    // - entries_unsubscribe_only_email: unsubscribe fields only for email entries
    // - entries_saved_metadata_only_saved: site_name/image_url only for saved entries
    // - entries_last_seen_only_fetched: last_seen_at only on web entries (migration 0153)
    // - entries_type_not_collection: no entry is a collection (migration 0121)
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
    // Distinct unread, non-spam articles in the tag's active subscriptions
    // (`apply_unread_memberships` / `recompute_list_counters`).
    unreadCount: integer("unread_count").notNull().default(0),

    // Opaque Google Reader folder sortid (issue #1117, migration 0097). Drawn
    // from the shared greader_id_seq; DB-assigned via a sequence default, so
    // inserts omit it. Never reversed, so no index.
    greaderSortid: bigint("greader_sortid", { mode: "bigint" })
      .notNull()
      .default(sql`nextval('greader_id_seq'::regclass)`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // Soft delete for sync tracking
  },
  (table) => [
    // Each user can only have one *live* tag with a given name, ignoring case. Partial on
    // deleted_at IS NULL so a soft-deleted (tombstoned) tag doesn't block reusing
    // its name — otherwise "News" → delete → "News" failed forever (issue #952).
    uniqueIndex("uq_tags_user_lower_name")
      .on(table.userId, sql`lower(${table.name})`)
      .where(sql`deleted_at IS NULL`),
    // Index for listing tags by user
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
    // NULL for a subscription without a feed, which a collection always is
    // (#1846); its type and name are its own, so reads never need the feed.
    feedId: uuid("feed_id").references(() => feeds.id, { onDelete: "cascade" }),
    // Never changes after insert.
    type: feedTypeEnum("type").notNull(),

    // The user's override for a feed's title; a collection's name (#1846).
    customTitle: text("custom_title"),
    fetchFullContent: boolean("fetch_full_content").notNull().default(false), // fetch full article from URL

    subscribedAt: timestamp("subscribed_at", { withTimezone: true }).notNull().defaultNow(), // critical for visibility
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }), // soft delete

    // The subscription's unread, non-spam memberships (#1846), kept by the
    // counter triggers, also while it's unsubscribed.
    unreadCount: integer("unread_count").notNull().default(0),

    // An email subscription's (normalized) sender address, unique per user
    // (#1846 phase 6). Its emails are owned by the subscription
    // (entries.owner_subscription_id).
    emailSender: text("email_sender"),

    // Google Reader feed stream id (issue #1117, migration 0097). Backs the
    // feed/{int} stream id and the subscription sortid; reversed by
    // feedStreamIdToSubscriptionUuid / resolveFeedStream with a unique-index seek.
    // Drawn from the shared greader_id_seq; DB-assigned via a sequence default,
    // except a saved subscription's, which is its saved feed's (#1846).
    greaderStreamId: bigint("greader_stream_id", { mode: "bigint" })
      .notNull()
      .default(sql`nextval('greader_id_seq'::regclass)`),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Unique constraint on user + feed
    unique("uq_subscriptions_user_feed").on(table.userId, table.feedId),
    index("idx_subscriptions_feed").on(table.feedId),
    uniqueIndex("idx_subscriptions_greader_stream_id").on(table.greaderStreamId),
    uniqueIndex("uq_subscriptions_id_user").on(table.id, table.userId),
    // Active collections' names are unique per user ignoring case (#1846).
    uniqueIndex("uq_subscriptions_user_collection_name")
      .on(table.userId, sql`lower(${table.customTitle})`)
      .where(sql`type = 'collection' AND unsubscribed_at IS NULL`),
    // Only web subscriptions have a feed, and every other one has its own
    // name (#1846).
    check("subscriptions_feed_iff_web", sql`(type = 'web') = (feed_id IS NOT NULL)`),
    check("subscriptions_named_unless_web", sql`type = 'web' OR custom_title IS NOT NULL`),
    // One saved subscription per user (#1846).
    uniqueIndex("uq_subscriptions_saved_user")
      .on(table.userId)
      .where(sql`type = 'saved'`),
    // One email subscription per user and sender (#1846).
    uniqueIndex("uq_subscriptions_user_email_sender")
      .on(table.userId, table.emailSender)
      .where(sql`type = 'email'`),
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

    // Timestamps for idempotent updates - tracks when each field was last set
    // Used for conditional updates: only apply if incoming timestamp is newer
    // NULL means the user has never explicitly changed the read state
    readChangedAt: timestamp("read_changed_at", { withTimezone: true }),
    starredChangedAt: timestamp("starred_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // When the user's state (read, starred, memberships) last really changed.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // GREATEST(updated_at, entries.updated_at): when anything delta sync
    // reports about the entry last changed, so one index serves its keyset.
    // Trigger-maintained (migration 0150); never written by app code.
    changedAt: temporalTimestamp("changed_at")
      .notNull()
      .default(sql`now()`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // Denormalized timeline sort key: COALESCE(entries.published_at, entries.fetched_at).
    // Immutable per entry, so it's copied here at insert time (or filled by the
    // user_entries_fill_denormalized trigger) to enable a single (user_id, sort_key, id)
    // index that covers the timeline list query's filter + sort. The DB enforces
    // NOT NULL; left optional here so callers may rely on the trigger to fill it.
    // temporalTimestamp so reads keep microsecond precision — this is the timeline
    // cursor sort key, where a Date's millisecond truncation corrupts pagination.
    publishedOrFetchedAt: temporalTimestamp("published_or_fetched_at"),

    // Denormalized entries.is_spam (immutable after insert — set only by email
    // ingest from the provider's verdict). The DB enforces NOT NULL; left optional
    // here so callers may rely on the trigger to fill it.
    isSpam: boolean("is_spam"),

    // How many active subscriptions hold the article (#1846): it's visible
    // iff this is positive or it's starred. Trigger-maintained, from
    // subscription_entries and subscriptions.unsubscribed_at; only
    // insertUserEntriesWithMemberships seeds a new row's, which they confirm.
    activeMemberships: integer("active_memberships").notNull().default(0),

    // How much the user wants the article (#2064): higher sorts first, NULL
    // after every scored one. Memberships and tag rows carry copies.
    score: doublePrecision("score"),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.entryId] }),
    // For joins from entries table
    index("idx_user_entries_entry_id").on(table.entryId),
    // Delta sync's keyset.
    index("idx_user_entries_changed_at").on(table.userId, table.changedAt, table.entryId),
    // Partial indexes defined in migration (can't express WHERE clause in drizzle)
  ]
);

/**
 * Which articles each subscription holds, for every type (#1846): an
 * article's source subscription, its collections, and for a saved article the
 * user's saved subscription. Every path that gives a user an article writes
 * its membership (`services/subscription-entries.ts`); triggers keep the
 * counters and `user_entries.active_memberships` from it.
 */
export const subscriptionEntries = pgTable(
  "subscription_entries",
  {
    subscriptionId: uuid("subscription_id").notNull(),
    userId: uuid("user_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    // The user_entries row's sort key, which never changes.
    publishedOrFetchedAt: temporalTimestamp("published_or_fetched_at").notNull(),
    // Trigger-kept copies of the user_entries row's state ("Subscription
    // Attribution" in src/server/CLAUDE.md).
    read: boolean("read").notNull().default(false),
    starred: boolean("starred").notNull().default(false),
    score: doublePrecision("score"),
    // The article's place in this collection (#2064): lower sorts first, NULL
    // after every positioned one. Only collections' memberships have one.
    position: doublePrecision("position"),
  },
  (table) => [
    primaryKey({ columns: [table.subscriptionId, table.entryId] }),
    // Scope every membership to the subscription's owner and the owner's own
    // user_entries row, so none can cross users. The second foreign key,
    // (user_id, entry_id) → user_entries, is deferred and doesn't cascade
    // deletes: the user_entries delete trigger counts a deleted article's
    // memberships, then removes them (migration 0133).
    foreignKey({
      columns: [table.subscriptionId, table.userId],
      foreignColumns: [subscriptions.id, subscriptions.userId],
    }).onDelete("cascade"),
    index("idx_subscription_entries_timeline").on(
      table.subscriptionId,
      table.publishedOrFetchedAt.desc(),
      table.entryId.desc()
    ),
    index("idx_subscription_entries_read_timeline").on(
      table.subscriptionId,
      table.read,
      table.publishedOrFetchedAt.desc(),
      table.entryId.desc()
    ),
    index("idx_subscription_entries_user_entry").on(table.userId, table.entryId),
  ]
);

/**
 * A tag's or Uncategorized's list rows, kept by triggers ("Subscription
 * Attribution" in src/server/CLAUDE.md). `list_id` is the tag's id, or the
 * user's for Uncategorized.
 */
export const tagEntries = pgTable(
  "tag_entries",
  {
    userId: uuid("user_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    listId: uuid("list_id").notNull(),
    publishedOrFetchedAt: temporalTimestamp("published_or_fetched_at").notNull(),
    read: boolean("read").notNull(),
    starred: boolean("starred").notNull(),
    score: doublePrecision("score"),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.entryId, table.listId] }),
    foreignKey({
      columns: [table.userId, table.entryId],
      foreignColumns: [userEntries.userId, userEntries.entryId],
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
  ]
);

/**
 * Hard-deleted entries (saved articles), reported to delta-sync clients so they
 * drop local copies. No FK to entries: the entry row is gone by definition.
 * Pruned by the retention job (see services/entry-tombstones.ts).
 */
export const entryTombstones = pgTable(
  "entry_tombstones",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id").notNull(),
    // Microsecond precision: this is the deletions sync cursor.
    deletedAt: temporalTimestamp("deleted_at")
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.entryId] }),
    index("idx_entry_tombstones_user_deleted_at").on(table.userId, table.deletedAt),
    index("idx_entry_tombstones_deleted_at").on(table.deletedAt),
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
 * This view is DISPLAY-ONLY (subscription list surfaces): link/ownership/
 * scoping checks must query the subscriptions table directly.
 *
 * Note: This view is defined in migration 0035_subscription_views.sql
 * (most recently redefined in 0130_subscriptions_feed_optional.sql).
 * The Drizzle definition here allows type-safe queries against the view.
 */
export const userFeeds = pgView("user_feeds", {
  id: uuid("id").notNull(),
  userId: uuid("user_id").notNull(),
  subscribedAt: timestamp("subscribed_at", { withTimezone: true }).notNull(),
  feedId: uuid("feed_id"), // internal use only; NULL without a feed (LEFT JOIN)
  fetchFullContent: boolean("fetch_full_content").notNull(), // fetch full article from URL
  type: feedTypeEnum("type").notNull(),
  title: text("title"), // resolved title (custom or original)
  originalTitle: text("original_title"), // feed's original title for rename UI
  url: text("url"),
  siteUrl: text("site_url"),
  description: text("description"),
  unreadCount: integer("unread_count").notNull(), // trigger-maintained counter (migration 0092)
  // Google Reader feed stream id (subscriptions.greader_stream_id, migration
  // 0097). Display-only compat id; stripped from main-app/MCP responses.
  greaderStreamId: bigint("greader_stream_id", { mode: "bigint" }).notNull(),
}).existing();

/**
 * visible_entries view - Entries the user can see: starred, or in at least one
 * active subscription (`user_entries.active_memberships > 0`, #1846). An
 * entry's subscriptions come from its memberships (`entryMemberships`).
 *
 * Note: This view is defined in migration 0035_subscription_views.sql
 * (most recently redefined in 0168_entry_score_position.sql).
 * The Drizzle definition here allows type-safe queries against the view.
 */
export const visibleEntries = pgView("visible_entries", {
  userId: uuid("user_id").notNull(),
  id: uuid("id").notNull(),
  ownerFeedId: uuid("owner_feed_id"),
  type: feedTypeEnum("type").$type<EntryType>().notNull(),
  url: text("url"),
  title: text("title"),
  author: text("author"),
  contentOriginal: text("content_original"),
  contentCleaned: text("content_cleaned"),
  summary: text("summary"),
  siteName: text("site_name"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  contentHash: text("content_hash").notNull(),
  fullContentHash: text("full_content_hash"),
  isSpam: boolean("is_spam").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(), // GREATEST(entries, user_entries)
  entryUpdatedAt: timestamp("entry_updated_at", { withTimezone: true }).notNull(), // entries.updated_at alone
  fullContentOriginal: text("full_content_original"),
  fullContentCleaned: text("full_content_cleaned"),
  fullContentFetchedAt: timestamp("full_content_fetched_at", { withTimezone: true }),
  fullContentError: text("full_content_error"),
  read: boolean("read").notNull(),
  starred: boolean("starred").notNull(),
  unsubscribeUrl: text("unsubscribe_url"), // extracted from email HTML body
  readChangedAt: timestamp("read_changed_at", { withTimezone: true }),
  publishedOrFetchedAt: temporalTimestamp("published_or_fetched_at").notNull(), // denormalized timeline sort key (temporalTimestamp: µs-precise cursor sort key)
  // NOT NULL in reality (entries.greader_item_id is NOT NULL); typed non-null so
  // the compat id lookups (resolveGreaderIdsForEntries, entryIdsToWallabagIds)
  // read it without a cast.
  // Doubles as the Wallabag entry id (reversed by resolveWallabagEntry).
  greaderItemId: bigint("greader_item_id", { mode: "bigint" }).notNull(),
  // Stored full-text search vector (entries.search_vector; migration 0105).
  // searchEntries uses it for the `@@` match and the ts_rank sort — it is never
  // selected as a value, so the raw tsvector never crosses the service boundary.
  searchVector: tsvector("search_vector"),
  score: doublePrecision("score"),
}).existing();

// ============================================================================
// JOB QUEUE
// See src/server/jobs/CLAUDE.md for the overall architecture.
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
    type: text("type").notNull(), // a JobType (see JobPayloads in src/server/jobs/queue.ts)
    payload: nulSafeJsonb("payload").notNull().default({}).$type<Record<string, unknown>>(),

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
    // Index for polling: claim queries filter on type + next_run_at <= now
    // and order by next_run_at (restored by migration 0074)
    index("idx_jobs_polling").on(table.type, table.nextRunAt),
    // One fetch_feed job per feed: makes ensureFeedJob's INSERT ... ON CONFLICT
    // idempotent so concurrent subscribes can't create duplicate fetch jobs
    // (issue #952). Also serves feedId lookups.
    uniqueIndex("idx_jobs_feed_id")
      .on(sql`(${table.payload}->>'feedId')`)
      .where(sql`type = 'fetch_feed'`),
    // One row per singleton job type, which seedSingletonJobs relies on.
    uniqueIndex("jobs_singleton_type_unique")
      .on(table.type)
      .where(
        sql`type IN ('renew_websub', 'monitor_feed_health', 'cleanup', 'reconcile_membership_counters', 'backfill_getting_started')`
      ),
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
    // HMAC secret for verifying pushes. Stable for the row's whole life (never
    // rotated on renewal), so the hub and we always agree on it. See subscribeToHub.
    callbackSecret: text("callback_secret").notNull(),

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
  ]
);

/**
 * Per-hub push-reliability tally (keyed by hub URL).
 *
 * A WebSub hub can silently stop pushing while we still believe it's active. We
 * can't take action on a single miss, but aggregating, per hub, how new articles
 * first reached us lets us later spot chronically-broken hubs (e.g. Google's
 * pubsubhubbub.appspot.com, which accepts pings but never pushes):
 *
 * - `articlesAnnouncedByHub`: a new entry arrived via a hub push notification.
 * - `articlesAnnouncedByBackup`: a new entry was first discovered by the 24h
 *   backup poll on a feed we thought push was covering — a confident push miss
 *   (the entry was published long enough ago that a working hub should have
 *   pushed it).
 * - `articlesNearMiss`: a backup poll found a new entry, but it was published
 *   too recently (or with an unknown date) to confidently blame the hub — it may
 *   simply not have been pushed yet. Recorded separately so it doesn't inflate
 *   the miss count.
 *
 * Purely observational: nothing reads these to change fetch behavior (yet).
 */
export const websubHubStats = pgTable("websub_hub_stats", {
  hubUrl: text("hub_url").primaryKey(),
  articlesAnnouncedByHub: bigint("articles_announced_by_hub", { mode: "number" })
    .notNull()
    .default(0),
  articlesAnnouncedByBackup: bigint("articles_announced_by_backup", { mode: "number" })
    .notNull()
    .default(0),
  articlesNearMiss: bigint("articles_near_miss", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// NARRATION
// ============================================================================

/**
 * Narration content table - stores LLM-processed text for text-to-speech.
 * Keyed by content hash for deduplication across entries and saved articles.
 */
export const narrationContent = pgTable("narration_content", {
  id: uuid("id").primaryKey(), // UUIDv7
  contentHash: text("content_hash").unique().notNull(), // narrationContentHash (services/narration.ts)

  contentNarration: text("content_narration"), // null until generated
  // Paragraph map for highlighting (narration paragraph index -> data-para-id),
  // persisted alongside the narration: it is the only map guaranteed to align
  // with this exact text.
  paragraphMap: nulSafeJsonb("paragraph_map").$type<ParagraphMapEntry[]>(),
  generatedAt: timestamp("generated_at", { withTimezone: true }),

  // Error tracking for retry logic
  error: text("error"),
  errorAt: timestamp("error_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    promptVersion: smallint("prompt_version").notNull().default(1), // for cache invalidation
    maxWords: integer("max_words"), // user's max-words setting at generation time (null = unknown)
    promptHash: text("prompt_hash"), // SHA256 of the effective prompt at generation time (null = unknown)

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    generatedAt: timestamp("generated_at", { withTimezone: true }), // when summary was generated
  },
  (table) => [
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
 * Email format: {token}@{INGEST_EMAIL_DOMAIN}
 */
export const ingestAddresses = pgTable(
  "ingest_addresses",
  {
    id: uuid("id").primaryKey(), // UUIDv7
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    token: citext("token").unique().notNull(), // Random token for the email address
    label: text("label"), // User-provided name for the address

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // Soft delete, rejects future emails
  },
  (table) => [
    // For listing addresses by user
    index("idx_ingest_addresses_user").on(table.userId),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

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
    feedsData: nulSafeJsonb("feeds_data").$type<OpmlImportFeedData[]>().notNull(),

    // Results for each feed (populated as import progresses)
    results: nulSafeJsonb("results").$type<OpmlImportFeedResult[]>().notNull().default([]),

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

export type DiscordApiTokenLink = typeof discordApiTokenLinks.$inferSelect;
export type NewDiscordApiTokenLink = typeof discordApiTokenLinks.$inferInsert;

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
export type WebsubHubStats = typeof websubHubStats.$inferSelect;
export type NewWebsubHubStats = typeof websubHubStats.$inferInsert;

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

// View types
export type UserFeed = typeof userFeeds.$inferSelect;
export type VisibleEntry = typeof visibleEntries.$inferSelect;
