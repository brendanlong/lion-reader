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

import { eq, sql } from "drizzle-orm";
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
  oauthAccounts,
  oauthClients,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
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
    type: "web",
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

/**
 * Subscribes `userId` to `feedId`, with the feed's type unless overridden.
 * Returns the subscription id.
 */
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
    type: sql`(SELECT ${feeds.type} FROM ${feeds} WHERE ${feeds.id} = ${feedId})`,
    subscribedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return subscriptionId;
}

/**
 * Inserts a collection subscription with no feed row (#1846), as collections
 * will be once they stop having feeds. Returns the subscription id.
 */
export async function createTestFeedlessCollection(
  userId: string,
  name: string,
  overrides: Partial<typeof subscriptions.$inferInsert> = {}
): Promise<string> {
  const subscriptionId = overrides.id ?? generateUuidv7();
  const now = new Date();
  await db.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    feedId: null,
    type: "collection",
    customTitle: name,
    subscribedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return subscriptionId;
}

// ============================================================================
// Entries
// ============================================================================

export interface CreateTestEntryOptions extends Partial<typeof entries.$inferInsert> {
  /**
   * Users to make the entry visible to, by inserting unread `user_entries`
   * rows. The BEFORE INSERT trigger stamps `subscription_id` from each user's
   * subscription to this entry's feed.
   */
  userIds?: string[];
  /** Users from `userIds` who have starred the entry. */
  starredBy?: string[];
}

/**
 * Inserts an entry on `feedId`, defaulting to a web entry fetched now.
 *
 * `lastSeenAt` defaults to `fetchedAt` on web entries and is forced to null
 * otherwise, because `entries_last_seen_only_fetched` makes both mismatch
 * directions illegal.
 *
 * Note this alone does NOT make the entry visible to a new subscriber: the
 * subscribe-time populate also needs the feed's `lastEntriesUpdatedAt` set and
 * not-null, which `createTestFeed` deliberately leaves unset (see "Entry
 * Visibility" in `src/server/CLAUDE.md`). A test exercising that path has to
 * stamp the feed's fetch timestamps itself.
 */
export async function createTestEntry(
  feedId: string,
  options: CreateTestEntryOptions = {}
): Promise<string> {
  const { userIds, starredBy = [], ...overrides } = options;
  const entryId = overrides.id ?? generateUuidv7();
  const now = new Date();
  const type = overrides.type ?? "web";
  const fetchedAt = overrides.fetchedAt ?? now;

  await db.insert(entries).values({
    id: entryId,
    feedId,
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
    lastSeenAt: type === "web" ? (overrides.lastSeenAt ?? fetchedAt) : null,
  });

  if (userIds?.length) {
    await db.insert(userEntries).values(
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
