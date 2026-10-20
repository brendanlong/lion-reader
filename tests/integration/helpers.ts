/**
 * Shared row factories for the integration suite.
 *
 * Every integration test needs a user, and most need a feed/subscription/entry
 * behind it. These factories are the one place that knows how to build a valid
 * row, so a change to the schema or to a check constraint (e.g. `last_seen_at`
 * is web-only) is a single edit instead of dozens.
 *
 * Conventions:
 * - Factories return the new row's **id**; tests that need more re-read the row.
 * - Every factory takes Drizzle insert overrides, so a test can set any column
 *   without the factory growing a bespoke option per caller.
 * - Generated values (email, url, guid) embed the UUIDv7, so rows are unique
 *   across tests without a per-file counter.
 *
 * Cleanup stays per-file: tests delete the users/feeds they created in
 * `afterAll` (deleting a user cascades to its subscriptions and user_entries).
 */

import { and, eq, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  entries,
  subscriptions,
  subscriptionTags,
  tags,
  userEntries,
  ingestAddresses,
  oauthAccessTokens,
  oauthAccounts,
  oauthClients,
  oauthTokenGrants,
} from "../../src/server/db/schema";
import { createTokens, type TokenPair } from "../../src/server/oauth/service";
import { recordConsent } from "../../src/server/oauth/grants";
import { WALLABAG_CLIENT_ID } from "../../src/server/wallabag/client";
import { generateToken, hashToken } from "../../src/server/oauth/utils";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { insertUserEntriesWithMemberships } from "../../src/server/services/subscription-entries";
import type { OAuthProviderName } from "../../src/server/auth/oauth/config";
import type { Context } from "../../src/server/trpc/context";

// ============================================================================
// Users
// ============================================================================

export interface CreateTestUserOptions extends Partial<typeof users.$inferInsert> {
  /**
   * Prefix for the generated unique email, so a failing test's rows are
   * identifiable in the DB. Ignored when `email` is given.
   */
  emailPrefix?: string;
}

/**
 * Inserts a user with a password hash and a unique email. Returns its id.
 *
 * The signup agreements are accepted by default, because most procedures sit
 * behind `confirmedMiddleware` and would otherwise throw FORBIDDEN. Pass them
 * as null to test an unconfirmed account.
 */
export async function createTestUser(options: CreateTestUserOptions = {}): Promise<string> {
  const { emailPrefix = "user", ...overrides } = options;
  const userId = overrides.id ?? generateUuidv7();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${emailPrefix}-${userId}@test.com`,
    passwordHash: "test-hash",
    tosAgreedAt: now,
    privacyPolicyAgreedAt: now,
    notEuAgreedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return userId;
}

// ============================================================================
// Feeds
// ============================================================================

/** Inserts a web feed with a unique URL. Returns its id. */
export async function createTestFeed(
  overrides: Partial<typeof feeds.$inferInsert> = {}
): Promise<string> {
  const feedId = overrides.id ?? generateUuidv7();
  const now = new Date();
  await db.insert(feeds).values({
    id: feedId,
    url: `https://example.com/feed-${feedId}.xml`,
    title: `Test Feed ${feedId}`,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return feedId;
}

// ============================================================================
// Subscriptions
// ============================================================================

/** Subscribes `userId` to the web feed `feedId`. Returns the subscription id. */
export async function createTestSubscription(
  userId: string,
  feedId: string,
  overrides: Partial<typeof subscriptions.$inferInsert> = {}
): Promise<string> {
  const subscriptionId = overrides.id ?? generateUuidv7();
  const now = new Date();
  await db.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    feedId,
    type: "web",
    subscribedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return subscriptionId;
}

/**
 * Gives `userId` an email subscription to `emailSender` (a unique address by
 * default), as a sender's first email does: no feed, named after the sender.
 * It owns the user's emails from that sender (#1846). Returns its id.
 */
export async function createTestEmailSubscription(
  userId: string,
  overrides: Partial<typeof subscriptions.$inferInsert> = {}
): Promise<string> {
  const subscriptionId = overrides.id ?? generateUuidv7();
  const emailSender = overrides.emailSender ?? `sender-${subscriptionId}@example.com`;
  const now = new Date();
  await db.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    type: "email",
    emailSender,
    customTitle: emailSender,
    subscribedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return subscriptionId;
}

/**
 * Gives `userId` the saved subscription (#1846), as a first save does
 * (`ensure_saved_subscriptions`), without saving anything. Returns its id.
 */
export async function createTestSavedSubscription(userId: string): Promise<string> {
  await db.execute(sql`SELECT ensure_saved_subscriptions(ARRAY[${userId}::uuid])`);
  const [{ subscriptionId }] = await db
    .select({ subscriptionId: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.type, "saved")));
  return subscriptionId;
}

// ============================================================================
// Entries
// ============================================================================

export interface CreateTestEntryOptions extends Partial<typeof entries.$inferInsert> {
  /**
   * Users to make the entry visible to, by inserting unread `user_entries`
   * rows and each user's membership (#1846) in the entry's source: their
   * subscription to its feed, for an email its owner, for a saved article
   * their saved subscription (created if missing, as a first save does).
   */
  userIds?: string[];
  /** Users from `userIds` who have starred the entry. */
  starredBy?: string[];
}

/**
 * Inserts an entry owned by `owner`, defaulting to a web entry fetched now.
 * The owner is the entry's type's (#1846): a web entry's feed id, an email's
 * subscription id, a saved article's user id.
 *
 * `lastSeenAt` defaults to `fetchedAt` on web entries (pass `null` for one a
 * WebSub push inserted that no poll has seen) and is forced to null otherwise,
 * because `entries_last_seen_only_fetched` forbids it there.
 *
 * Note this alone does NOT make the entry visible to a new subscriber: the
 * subscribe-time populate also needs the feed's `lastEntriesUpdatedAt` set and
 * not-null, which `createTestFeed` deliberately leaves unset (see "Entry
 * Visibility" in `src/server/CLAUDE.md`). A test exercising that path has to
 * stamp the feed's fetch timestamps itself.
 */
export async function createTestEntry(
  owner: string,
  options: CreateTestEntryOptions = {}
): Promise<string> {
  const { userIds, starredBy = [], ...overrides } = options;
  const entryId = overrides.id ?? generateUuidv7();
  const now = new Date();
  const type = overrides.type ?? "web";
  const fetchedAt = overrides.fetchedAt ?? now;

  await db.insert(entries).values({
    id: entryId,
    ownerFeedId: type === "web" ? owner : null,
    ownerSubscriptionId: type === "email" ? owner : null,
    ownerUserId: type === "saved" ? owner : null,
    type,
    guid: `guid-${entryId}`,
    title: `Entry ${entryId}`,
    contentHash: `hash-${entryId}`,
    fetchedAt,
    publishedAt: fetchedAt,
    createdAt: fetchedAt,
    updatedAt: fetchedAt,
    ...overrides,
    // `lastSeenAt` is only permitted on web entries, so it can't come straight
    // from the overrides: a caller passing `type: "saved"` alongside the
    // default would violate the check constraint.
    lastSeenAt:
      type === "web"
        ? overrides.lastSeenAt === undefined
          ? fetchedAt
          : overrides.lastSeenAt
        : null,
  });

  if (userIds?.length) {
    await createTestUserEntries(
      userIds.map((userId) => ({
        userId,
        entryId,
        read: false,
        starred: starredBy.includes(userId),
      }))
    );
  }

  return entryId;
}

/**
 * Inserts `user_entries` rows as given, each with its membership (#1846) in
 * the entry's source, when the user has one: their subscription to its feed,
 * for an email its owner, for a saved article their saved subscription
 * (created if missing, as a first save does). A row with no such
 * subscription gets none, so it's visible only if starred.
 */
export async function createTestUserEntries(
  rows: PgInsertValue<typeof userEntries>[] | PgInsertValue<typeof userEntries>
): Promise<void> {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return;
  await db.insert(userEntries).values(list);
  const userIds = `{${list.map((r) => r.userId).join(",")}}`;
  const entryIds = `{${list.map((r) => r.entryId).join(",")}}`;
  await db.execute(sql`
    SELECT ensure_saved_subscriptions(ARRAY(
      SELECT c.user_id FROM unnest(${userIds}::uuid[], ${entryIds}::uuid[]) AS c(user_id, entry_id)
      JOIN entries e ON e.id = c.entry_id
      WHERE e.type = 'saved'
    ))
  `);
  await db.execute(sql`
    INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at,
                                      read, starred, is_spam)
    SELECT s.id, ue.user_id, ue.entry_id, ue.published_or_fetched_at, ue.read, ue.starred, ue.is_spam
    FROM unnest(${userIds}::uuid[], ${entryIds}::uuid[]) AS c(user_id, entry_id)
    JOIN user_entries ue ON ue.user_id = c.user_id AND ue.entry_id = c.entry_id
    JOIN entries e ON e.id = ue.entry_id
    JOIN subscriptions s ON s.user_id = ue.user_id
      AND (s.feed_id = e.owner_feed_id OR s.id = e.owner_subscription_id
           OR (e.type = 'saved' AND s.type = 'saved'))
    ON CONFLICT DO NOTHING
  `);
}

/**
 * Inserts `count` entries owned by `owner` (as `createTestEntry`), the i-th
 * fetched and published at `start + i * stepMs`, in one statement. Returns
 * their ids oldest first.
 */
export async function createTestEntryBatch(
  owner: string,
  count: number,
  {
    type = "web",
    start,
    stepMs = 1000,
    isSpam = false,
  }: { type?: "web" | "email" | "saved"; start: Date; stepMs?: number; isSpam?: boolean }
): Promise<string[]> {
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO entries (id, owner_feed_id, owner_subscription_id, owner_user_id, type, guid,
                         title, content_hash, is_spam, fetched_at, published_at, created_at,
                         updated_at, last_seen_at)
    SELECT x.id,
           CASE WHEN ${type} = 'web' THEN ${owner}::uuid END,
           CASE WHEN ${type} = 'email' THEN ${owner}::uuid END,
           CASE WHEN ${type} = 'saved' THEN ${owner}::uuid END,
           ${type}::feed_type, 'guid-' || x.id, 'Entry ' || x.id, 'hash-' || x.id, ${isSpam},
           x.at, x.at, x.at, x.at, CASE WHEN ${type} = 'web' THEN x.at END
    FROM (
      SELECT uuidv7() AS id, ${start.toISOString()}::timestamptz + make_interval(secs => i * ${stepMs}::float8 / 1000) AS at, i
      FROM generate_series(0, ${count - 1}::int) AS i
    ) x
    ORDER BY x.i
    RETURNING id
  `);
  return result.rows.map((row) => row.id);
}

/**
 * Puts a user's article in `subscriptionId` (#1846), as a redirect merge
 * copies an old feed's articles into the survivor, creating the user's row
 * (unread unless `read`) if they have none.
 */
export async function createTestMembership(
  subscriptionId: string,
  userId: string,
  entryId: string,
  { read = false }: { read?: boolean } = {}
): Promise<void> {
  await insertUserEntriesWithMemberships(
    db,
    sql`
      SELECT ${subscriptionId}::uuid AS subscription_id, ${userId}::uuid AS user_id, e.id AS entry_id,
             COALESCE(e.published_at, e.fetched_at) AS published_or_fetched_at,
             e.is_spam, ${read}::boolean AS read
      FROM entries e WHERE e.id = ${entryId}
    `
  );
}

/**
 * A web subscription that has had its first grant (it holds an entry), so the
 * backfill guard applies to what the fan-out gives it next. The entry it holds
 * is read, its guid starts `held-before-`, and is not among the feed's current entries.
 */
export async function createWatchingSubscription(userId: string, feedId: string): Promise<string> {
  const subscriptionId = await createTestSubscription(userId, feedId);
  const longAgo = new Date("2000-01-01T00:00:00Z");
  const entryId = await createTestEntry(feedId, {
    guid: `held-before-${subscriptionId}`,
    fetchedAt: longAgo,
    lastSeenAt: null,
  });
  await createTestMembership(subscriptionId, userId, entryId, { read: true });
  return subscriptionId;
}

// ============================================================================
// Tags
// ============================================================================

export interface CreateTestTagOptions extends Partial<typeof tags.$inferInsert> {
  /** Subscriptions to put under the tag, via `subscription_tags` rows. */
  subscriptionIds?: string[];
}

/** Inserts a tag owned by `userId`. Returns its id. */
export async function createTestTag(
  userId: string,
  options: CreateTestTagOptions = {}
): Promise<string> {
  const { subscriptionIds, ...overrides } = options;
  const tagId = overrides.id ?? generateUuidv7();
  await db.insert(tags).values({ id: tagId, userId, name: `Tag ${tagId}`, ...overrides });
  if (subscriptionIds?.length) {
    await db
      .insert(subscriptionTags)
      .values(subscriptionIds.map((subscriptionId) => ({ tagId, subscriptionId })));
  }
  return tagId;
}

// ============================================================================
// Email ingest addresses
// ============================================================================

/**
 * Inserts an ingest address for `userId`; mail to `{token}@<ingest domain>`
 * reaches it. Pass `token` to know what to address. Returns its id.
 */
export async function createTestIngestAddress(
  userId: string,
  overrides: Partial<typeof ingestAddresses.$inferInsert> = {}
): Promise<string> {
  const id = overrides.id ?? generateUuidv7();
  await db.insert(ingestAddresses).values({ id, userId, token: `token-${id}`, ...overrides });
  return id;
}

// ============================================================================
// OAuth clients
// ============================================================================

/**
 * Inserts a registered (DCR-style) OAuth client. Returns its `client_id`, which
 * is what every OAuth code path keys on rather than the row's uuid.
 *
 * Cleanup is per-file like the other factories: `oauth_clients` has no user FK,
 * so deleting the test's users doesn't cascade to it.
 */
export async function createTestOAuthClient(
  overrides: Partial<typeof oauthClients.$inferInsert> = {}
): Promise<string> {
  const clientId = overrides.clientId ?? generateUuidv7();
  await db.insert(oauthClients).values({
    id: generateUuidv7(),
    clientId,
    name: `Test Client ${clientId.slice(-6)}`,
    redirectUris: ["https://example.com/callback"],
    scopes: ["mcp"],
    isPublic: true,
    ...overrides,
  });
  return clientId;
}

/**
 * Inserts a token grant for seeding token rows directly. Tests of the token
 * paths themselves mint through `createTokens` instead.
 */
export async function createTestTokenGrant(
  userId: string,
  overrides: Partial<typeof oauthTokenGrants.$inferInsert> = {}
): Promise<string> {
  const id = overrides.id ?? generateUuidv7();
  const clientId = overrides.clientId ?? "test-client";
  await db.insert(oauthTokenGrants).values({
    id,
    userId,
    clientId,
    consentGrantId:
      clientId === WALLABAG_CLIENT_ID ? null : await recordConsent(userId, clientId, ["mcp"]),
    scopes: ["mcp"],
    ...overrides,
  });
  return id;
}

/**
 * Links a social provider to `userId` directly, for tests that need an account
 * already linked rather than to exercise the linking path itself (which is
 * `linkOAuthAccount`, and revokes sessions).
 */
export async function createTestOAuthLink(
  userId: string,
  provider: OAuthProviderName,
  overrides: Partial<typeof oauthAccounts.$inferInsert> = {}
): Promise<void> {
  await db.insert(oauthAccounts).values({
    id: generateUuidv7(),
    userId,
    provider,
    providerAccountId: `${provider}-${userId}`,
    ...overrides,
  });
}

/**
 * Mints a token pair the way a finished authorization does, recording the
 * user's consent first unless the client is Wallabag's, which has none.
 */
export async function createTestOAuthTokens(
  params: Omit<Parameters<typeof createTokens>[0], "consentGrantId">
): Promise<TokenPair> {
  const consentGrantId =
    params.clientId === WALLABAG_CLIENT_ID
      ? null
      : await recordConsent(params.userId, params.clientId, params.scopes);
  return createTokens({ ...params, consentGrantId });
}

/**
 * An OAuth access token without the access-token prefix, as releases before the
 * prefix minted them: minted, then the row re-keyed to a bare token.
 */
export async function createTestUnprefixedAccessToken(
  params: Parameters<typeof createTestOAuthTokens>[0]
): Promise<string> {
  const { accessToken } = await createTestOAuthTokens(params);
  const unprefixed = generateToken();
  await db
    .update(oauthAccessTokens)
    .set({ tokenHash: hashToken(unprefixed) })
    .where(eq(oauthAccessTokens.tokenHash, hashToken(accessToken)));
  return unprefixed;
}

// ============================================================================
// tRPC context
// ============================================================================

/**
 * Builds a session-authenticated tRPC context for `userId`, reading the real
 * user row so the context can't drift from the schema the way a hand-written
 * literal does. The session itself is synthetic — no `sessions` row is needed,
 * because nothing downstream of the context re-validates it.
 */
export async function createAuthContext(userId: string): Promise<Context> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    throw new Error(`createAuthContext: no user with id ${userId}`);
  }
  const now = new Date();

  return {
    db,
    session: {
      session: {
        id: generateUuidv7(),
        userId,
        tokenHash: "test-hash",
        scopes: null,
        userAgent: null,
        ipAddress: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 3600000),
        revokedAt: null,
        lastActiveAt: now,
      },
      user,
    },
    apiToken: null,
    authType: "session",
    scopes: [],
    sessionToken: "test-token",
    headers: new Headers(),
  };
}

/**
 * Builds a tRPC context with no session or API token. `headers` lets a test
 * present credentials that aren't a session, e.g. the admin Bearer secret.
 */
export function createUnauthContext(headers: Headers = new Headers()): Context {
  return {
    db,
    session: null,
    apiToken: null,
    authType: null,
    scopes: [],
    sessionToken: null,
    headers,
  };
}

// ============================================================================
// Concurrency
// ============================================================================

/** Resolves once a query matching the `ILIKE` pattern is waiting for a lock. */
export async function waitForLockWaiter(pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await db.execute(sql`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE ${pattern}
    `);
    if ((result.rows[0] as { waiting: number }).waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("nothing ever waited on the lock");
}

/**
 * Runs `work` in a transaction left open until `commit` is called, so another
 * operation can be started against its uncommitted writes.
 */
export async function holdTransaction(
  work: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<unknown>
): Promise<{ commit: () => Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const done = db.transaction(async (tx) => {
    await work(tx);
    started();
    await gate;
  });
  await ready;
  return {
    commit: async () => {
      release();
      await done;
    },
  };
}
