/**
 * E2E test helpers: direct database seeding and Redis utilities.
 *
 * Tests create their own isolated users/feeds/entries directly in the test
 * database (no UI signup flow) and authenticate by inserting a session row
 * and setting the `session` cookie on the browser context.
 *
 * Requires DATABASE_URL and REDIS_URL (loaded from .env.test via `pnpm test:e2e`).
 */

import crypto from "node:crypto";
import * as argon2 from "argon2";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import Redis from "ioredis";
import type { BrowserContext, Page } from "@playwright/test";
import * as schema from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";

// Includes $client so a TestDb satisfies the app's `typeof db` and can be
// passed to service functions (e.g. the counts service) directly.
export type TestDb = NodePgDatabase<typeof schema> & { $client: Pool };

let pool: Pool | undefined;
let redis: Redis | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Run e2e tests via "pnpm test:e2e" so .env.test is loaded.`
    );
  }
  return value;
}

export function getDb(): TestDb {
  pool ??= new Pool({ connectionString: requireEnv("DATABASE_URL"), max: 5 });
  return drizzle(pool, { schema });
}

function getRedis(): Redis {
  redis ??= new Redis(requireEnv("REDIS_URL"));
  return redis;
}

/** Close shared connections so the Playwright worker can exit cleanly. */
export async function closeTestConnections(): Promise<void> {
  await pool?.end();
  pool = undefined;
  redis?.disconnect();
  redis = undefined;
}

// ============================================================================
// Seeding
// ============================================================================

export interface TestUser {
  id: string;
  email: string;
  sessionToken: string;
}

/**
 * Creates a user that passes both authentication and signup confirmation
 * (TOS/privacy/not-EU agreements), plus a valid session.
 */
export async function createConfirmedUser(db: TestDb): Promise<TestUser> {
  const now = new Date();
  const id = generateUuidv7();
  const email = `e2e-${id}@example.com`;

  await db.insert(schema.users).values({
    id,
    email,
    emailVerifiedAt: now,
    tosAgreedAt: now,
    privacyPolicyAgreedAt: now,
    notEuAgreedAt: now,
  });

  // Mirrors createSession in src/server/auth/session.ts: raw token goes in the
  // cookie, only the SHA-256 hash is stored.
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  await db.insert(schema.sessions).values({
    id: generateUuidv7(),
    userId: id,
    tokenHash: crypto.createHash("sha256").update(sessionToken).digest("hex"),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  return { id, email, sessionToken };
}

export interface TestPasswordUser {
  id: string;
  email: string;
  password: string;
}

/**
 * Creates a confirmed user with a password hash (no session), for exercising
 * password-based auth flows: the Wallabag OAuth password grant and the Google
 * Reader ClientLogin endpoint. Mirrors createConfirmedUser's confirmation
 * columns so requireAuth's signup-confirmation gate passes.
 */
export async function createPasswordUser(
  db: TestDb,
  password = "correct-horse-battery-staple"
): Promise<TestPasswordUser> {
  const now = new Date();
  const id = generateUuidv7();
  const email = `e2e-${id}@example.com`;

  await db.insert(schema.users).values({
    id,
    email,
    passwordHash: await argon2.hash(password),
    emailVerifiedAt: now,
    tosAgreedAt: now,
    privacyPolicyAgreedAt: now,
    notEuAgreedAt: now,
  });

  return { id, email, password };
}

/** Sets the session cookie so the browser context is logged in as the user. */
export async function loginAs(
  context: BrowserContext,
  user: TestUser,
  baseURL: string
): Promise<void> {
  await context.addCookies([{ name: "session", value: user.sessionToken, url: baseURL }]);
}

export interface TestFeed {
  feedId: string;
  subscriptionId: string;
  title: string;
}

/** Creates a web feed and an active subscription (with subscription_feeds row). */
export async function createSubscribedFeed(db: TestDb, userId: string): Promise<TestFeed> {
  const feedId = generateUuidv7();
  const subscriptionId = generateUuidv7();
  const title = `E2E Feed ${feedId.slice(-6)}`;

  await db.insert(schema.feeds).values({
    id: feedId,
    type: "web",
    url: `https://example.com/e2e/${feedId}/feed.xml`,
    title,
    siteUrl: `https://example.com/e2e/${feedId}`,
  });
  await db.insert(schema.subscriptions).values({ id: subscriptionId, userId, feedId });
  // visible_entries maps entries to subscriptions through subscription_feeds
  await db.insert(schema.subscriptionFeeds).values({ subscriptionId, feedId, userId });

  return { feedId, subscriptionId, title };
}

/** Creates a tag and assigns it to a subscription. Returns the tag ID. */
export async function createTagOnSubscription(
  db: TestDb,
  userId: string,
  subscriptionId: string,
  name: string
): Promise<string> {
  const tagId = generateUuidv7();
  await db.insert(schema.tags).values({ id: tagId, userId, name });
  await db.insert(schema.subscriptionTags).values({ subscriptionId, tagId });
  return tagId;
}

/** Stars an entry directly in the database (keeps it unread). */
export async function starEntry(db: TestDb, userId: string, entryId: string): Promise<void> {
  const now = new Date();
  await db
    .update(schema.userEntries)
    .set({ starred: true, starredChangedAt: now, updatedAt: now })
    .where(and(eq(schema.userEntries.userId, userId), eq(schema.userEntries.entryId, entryId)));
}

export interface TestEntry {
  id: string;
  title: string;
  updatedAt: Date;
  url: string;
  summary: string;
  publishedAt: Date;
  fetchedAt: Date;
}

/** Creates an entry plus the user_entries row that makes it visible (unread). */
export async function createUnreadEntry(
  db: TestDb,
  params: { feedId: string; userId: string; title: string }
): Promise<TestEntry> {
  const { feedId, userId, title } = params;
  const id = generateUuidv7();
  const now = new Date();
  const content = `<p>Content for ${title}</p>`;

  const [entry] = await db
    .insert(schema.entries)
    .values({
      id,
      feedId,
      type: "web",
      guid: `e2e-${id}`,
      url: `https://example.com/e2e/posts/${id}`,
      title,
      contentOriginal: content,
      summary: `Summary for ${title}`,
      publishedAt: now,
      fetchedAt: now,
      lastSeenAt: now, // required for web entries (entries_last_seen_only_fetched)
      contentHash: crypto.createHash("sha256").update(content).digest("hex"),
    })
    .returning();

  await db.insert(schema.userEntries).values({
    userId,
    entryId: id,
    publishedOrFetchedAt: now,
  });

  return {
    id,
    title,
    updatedAt: entry.updatedAt,
    url: entry.url ?? "",
    summary: entry.summary ?? "",
    publishedAt: now,
    fetchedAt: now,
  };
}

/**
 * Creates the user's saved-articles feed (type='saved', no subscription) and a
 * saved entry in it, plus the user_entries row that makes it visible (unread).
 * Mirrors the shape produced by the saved-articles service. Returns the saved
 * feed id and the entry.
 */
export async function createSavedArticle(
  db: TestDb,
  params: { userId: string; title: string }
): Promise<{ savedFeedId: string; entry: TestEntry }> {
  const { userId, title } = params;

  // One saved feed per user (unique index on (user_id) WHERE type='saved').
  const savedFeedId = generateUuidv7();
  const inserted = await db
    .insert(schema.feeds)
    .values({ id: savedFeedId, type: "saved", userId, title: "Saved Articles" })
    .onConflictDoNothing()
    .returning({ id: schema.feeds.id });
  const feedId =
    inserted[0]?.id ??
    (
      await db
        .select({ id: schema.feeds.id })
        .from(schema.feeds)
        .where(and(eq(schema.feeds.type, "saved"), eq(schema.feeds.userId, userId)))
        .limit(1)
    )[0].id;

  const id = generateUuidv7();
  const now = new Date();
  const content = `<p>Content for ${title}</p>`;
  const url = `https://example.com/e2e/saved/${id}`;
  const [entry] = await db
    .insert(schema.entries)
    .values({
      id,
      feedId,
      type: "saved",
      guid: url,
      url,
      title,
      contentOriginal: content,
      contentCleaned: content,
      summary: `Summary for ${title}`,
      publishedAt: null,
      fetchedAt: now,
      contentHash: crypto.createHash("sha256").update(content).digest("hex"),
    })
    .returning();

  await db.insert(schema.userEntries).values({ userId, entryId: id, publishedOrFetchedAt: now });

  return {
    savedFeedId: feedId,
    entry: {
      id,
      title,
      updatedAt: entry.updatedAt,
      url,
      summary: entry.summary ?? "",
      publishedAt: now,
      fetchedAt: now,
    },
  };
}

/** Marks an entry read directly in the database, returning the update timestamp. */
export async function markEntryRead(db: TestDb, userId: string, entryId: string): Promise<Date> {
  const now = new Date();
  await db
    .update(schema.userEntries)
    .set({ read: true, readChangedAt: now, updatedAt: now })
    .where(and(eq(schema.userEntries.userId, userId), eq(schema.userEntries.entryId, entryId)));
  return now;
}

// ============================================================================
// SSE / Redis synchronization
// ============================================================================

/**
 * Waits until the app server's SSE handler has subscribed to a Redis channel.
 *
 * The SSE endpoint subscribes asynchronously after the response starts
 * streaming, so publishing immediately after the SSE response arrives can
 * drop the event. Polling PUBSUB NUMSUB removes that race: tests create
 * unique users/feeds, so each channel has exactly one possible subscriber.
 */
export async function waitForChannelSubscriber(channel: string, timeoutMs = 15_000): Promise<void> {
  const client = getRedis();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = (await client.call("pubsub", "numsub", channel)) as [string, number | string];
    if (Number(result[1]) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No SSE subscriber on Redis channel ${channel} after ${timeoutMs}ms`);
}

// ============================================================================
// Request tracking
// ============================================================================

/**
 * Records the tRPC procedure names of every request the page makes.
 *
 * Returns a live array; clear it (`calls.length = 0`) after initial page load,
 * then assert on what fired afterwards. Batched requests like
 * `/api/trpc/entries.list,entries.count?batch=1` are split into individual
 * procedure names.
 */
export function recordTrpcProcedures(page: Page): string[] {
  const calls: string[] = [];
  page.on("request", (request) => {
    const match = request.url().match(/\/api\/trpc\/([^?]+)/);
    if (match) {
      calls.push(...decodeURIComponent(match[1]).split(","));
    }
  });
  return calls;
}
