/**
 * Integration tests for the summarization router's read path.
 *
 * The key security invariant: cached AI summaries are re-sanitized on read with
 * the *current* sanitizer rules before being returned for `dangerouslySetInnerHTML`
 * rendering. This means a rules change that closes a sanitizer hole reaches every
 * stored summary on the next read, with no version column or migration (see the
 * read-path comment in src/server/trpc/routers/summarization.ts). These tests lock
 * that in so the sanitize-on-read guarantee can't be silently dropped.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, userEntries, entrySummaries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import { CURRENT_PROMPT_VERSION } from "../../src/server/services/summarization";
import { getOrCreateSavedFeed } from "../../src/server/feed/saved-feed";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestUser,
} from "./helpers";

/**
 * Creates an entry and makes it reachable the way the app does. The router
 * reads through `visible_entries`, so a `user_entries` row alone isn't enough:
 * an ordinary entry also needs an active subscription (`unsubscribed: true`
 * soft-deletes it, hiding an unstarred entry), while a `saved: true` article
 * lives in the per-user saved feed and is visible on its type alone.
 */
async function createVisibleEntry(
  userId: string,
  contentHash: string,
  options: { unsubscribed?: boolean; saved?: boolean; fullContentHash?: string } = {}
): Promise<string> {
  const now = new Date();
  let feedId: string;
  if (options.saved) {
    feedId = await getOrCreateSavedFeed(db, userId);
  } else {
    // The fetch timestamps are what make the entry current for this
    // subscription; createTestFeed builds a never-polled feed.
    feedId = await createTestFeed({
      title: "Test Feed",
      lastFetchedAt: now,
      lastEntriesUpdatedAt: now,
    });
    await createTestSubscription(userId, feedId, {
      unsubscribedAt: options.unsubscribed ? now : null,
    });
  }
  const entryId = await createTestEntry(feedId, {
    type: options.saved ? "saved" : "web",
    title: "Test Entry",
    contentCleaned: "<p>Some article content to summarize.</p>",
    // The summary cache is keyed off this, so it's the caller's value verbatim.
    contentHash,
    ...(options.fullContentHash
      ? {
          fullContentHash: options.fullContentHash,
          fullContentCleaned: "<p>The full article body, fetched from the site.</p>",
        }
      : {}),
    fetchedAt: now,
  });
  // Not createTestEntry's `userIds`, which can't express the explicit change
  // stamps. subscription_id is filled by the user_entries_fill_denormalized
  // trigger.
  await db.insert(userEntries).values({
    userId,
    entryId,
    read: false,
    starred: false,
    readChangedAt: now,
    starredChangedAt: now,
    updatedAt: now,
  });
  return entryId;
}

const createdUserIds: string[] = [];
let previousAnthropicKey: string | undefined;
let previousGroqKey: string | undefined;

beforeAll(() => {
  // Make summarization "available" via the server key so the router reaches the
  // cached read path (no real LLM call — a cached summary is returned first).
  previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-server-key";
  // ...and make sure Groq is *not* configured: the regenerate tests below point
  // the user at a Groq model so the generation path fails at "no key" instead
  // of making a real network call.
  previousGroqKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
});

afterAll(async () => {
  if (previousAnthropicKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
  }
  if (previousGroqKey === undefined) {
    delete process.env.GROQ_API_KEY;
  } else {
    process.env.GROQ_API_KEY = previousGroqKey;
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("summarization.generate cached read path", () => {
  let userId: string;

  beforeEach(async () => {
    userId = await createTestUser({ emailPrefix: "summ" });
    createdUserIds.push(userId);
  });

  it("re-sanitizes a cached summary containing disallowed HTML on read", async () => {
    const contentHash = `hash-${generateUuidv7()}`;
    const entryId = await createVisibleEntry(userId, contentHash);

    // Simulate a summary stored before a sanitizer hardening: it still carries a
    // <script> tag and an inline event handler that the current sanitizer strips.
    await db.insert(entrySummaries).values({
      id: generateUuidv7(),
      userId,
      contentHash,
      summaryText:
        '<p onclick="steal()">Summary body</p><script>alert(1)</script><img src=x onerror="alert(2)">',
      modelId: "claude-test",
      promptVersion: CURRENT_PROMPT_VERSION,
      generatedAt: new Date(),
      createdAt: new Date(),
    });

    const caller = createCaller(await createAuthContext(userId));
    const result = await caller.summarization.generate({ entryId, useFullContent: false });

    expect(result.cached).toBe(true);
    // The safe text survives; the dangerous markup is gone.
    expect(result.summary).toContain("Summary body");
    expect(result.summary).not.toContain("<script>");
    expect(result.summary.toLowerCase()).not.toContain("onclick");
    expect(result.summary.toLowerCase()).not.toContain("onerror");
  });
});

describe("summarization.generate entry visibility", () => {
  let userId: string;

  beforeEach(async () => {
    userId = await createTestUser({ emailPrefix: "summ" });
    createdUserIds.push(userId);
  });

  // The router reads through `visible_entries`, so it applies exactly the rule
  // the entry list does: a `user_entries` row alone doesn't grant access (#1468).
  it("rejects an entry hidden by visibility even though a user_entries row exists", async () => {
    const entryId = await createVisibleEntry(userId, `hash-${generateUuidv7()}`, {
      unsubscribed: true,
    });
    const caller = createCaller(await createAuthContext(userId));

    await expect(caller.summarization.generate({ entryId })).rejects.toThrow("Entry not found");
  });

  it("rejects another user's entry", async () => {
    const otherUserId = await createTestUser({ emailPrefix: "summ" });
    createdUserIds.push(otherUserId);
    const entryId = await createVisibleEntry(otherUserId, `hash-${generateUuidv7()}`);
    const caller = createCaller(await createAuthContext(userId));

    await expect(caller.summarization.generate({ entryId })).rejects.toThrow("Entry not found");
  });

  // ...and the arm of that rule with no subscription row at all still resolves,
  // which is the risk in reading through the view.
  it("summarizes a saved article, which has no subscription row", async () => {
    const contentHash = `hash-${generateUuidv7()}`;
    const entryId = await createVisibleEntry(userId, contentHash, { saved: true });
    await db.insert(entrySummaries).values({
      id: generateUuidv7(),
      userId,
      contentHash,
      summaryText: "<p>Saved article summary</p>",
      modelId: "claude-test",
      promptVersion: CURRENT_PROMPT_VERSION,
      generatedAt: new Date(),
      createdAt: new Date(),
    });

    const caller = createCaller(await createAuthContext(userId));
    const result = await caller.summarization.generate({ entryId, useFullContent: false });

    expect(result.cached).toBe(true);
    expect(result.summary).toContain("Saved article summary");
  });
});

/**
 * `regenerate: true` is documented as "skip the cache and regenerate", and the
 * REST/OpenAPI and MCP surfaces can send it without `useFullContent` (the web
 * client always sends the flag). These lock in that the `useFullContent`-omitted
 * branch honours it too.
 *
 * The user is pointed at a Groq model while only the Anthropic server key is
 * set, so once the router gets past the cache it fails deterministically with
 * "Groq API key not configured" — no network call, and reaching that error is
 * itself the proof that the cached summary was not served.
 */
describe("summarization.generate regenerate bypasses the cache", () => {
  const UNCONFIGURED_MODEL = "groq:llama-3.3-70b-versatile";

  async function createUser(): Promise<string> {
    const userId = await createTestUser({
      emailPrefix: "summ",
      summarizationModel: UNCONFIGURED_MODEL,
    });
    createdUserIds.push(userId);
    return userId;
  }

  async function cacheSummary(userId: string, contentHash: string, text: string): Promise<void> {
    await db.insert(entrySummaries).values({
      id: generateUuidv7(),
      userId,
      contentHash,
      summaryText: text,
      modelId: UNCONFIGURED_MODEL,
      promptVersion: CURRENT_PROMPT_VERSION,
      generatedAt: new Date(),
      createdAt: new Date(),
    });
  }

  it("serves the cached feed summary when regenerate is not set", async () => {
    const userId = await createUser();
    const contentHash = `hash-${generateUuidv7()}`;
    const entryId = await createVisibleEntry(userId, contentHash);
    await cacheSummary(userId, contentHash, "<p>Cached feed summary</p>");

    const caller = createCaller(await createAuthContext(userId));
    const result = await caller.summarization.generate({ entryId });

    expect(result.cached).toBe(true);
    expect(result.summary).toContain("Cached feed summary");
  });

  it("skips the cached feed summary when regenerate is true", async () => {
    const userId = await createUser();
    const contentHash = `hash-${generateUuidv7()}`;
    const entryId = await createVisibleEntry(userId, contentHash);
    await cacheSummary(userId, contentHash, "<p>Cached feed summary</p>");

    const caller = createCaller(await createAuthContext(userId));

    await expect(caller.summarization.generate({ entryId, regenerate: true })).rejects.toThrow(
      "Groq API key not configured"
    );

    // The generation attempt is recorded on the cached row, so the request
    // really reached the LLM call rather than short-circuiting on the cache.
    const [row] = await db
      .select()
      .from(entrySummaries)
      .where(eq(entrySummaries.userId, userId))
      .limit(1);
    expect(row.errorAt).not.toBeNull();
    // The stored summary is left alone for the next non-regenerate read.
    expect(row.summaryText).toContain("Cached feed summary");
  });

  it("skips the cached full-content summary when regenerate is true", async () => {
    const userId = await createUser();
    const contentHash = `hash-${generateUuidv7()}`;
    const fullContentHash = `full-hash-${generateUuidv7()}`;
    const entryId = await createVisibleEntry(userId, contentHash, { fullContentHash });
    await cacheSummary(userId, fullContentHash, "<p>Cached full-content summary</p>");

    const caller = createCaller(await createAuthContext(userId));

    // Control: without the flag the full-content summary is served.
    const cached = await caller.summarization.generate({ entryId });
    expect(cached.cached).toBe(true);
    expect(cached.summary).toContain("Cached full-content summary");

    await expect(caller.summarization.generate({ entryId, regenerate: true })).rejects.toThrow(
      "Groq API key not configured"
    );
  });
});

/**
 * `entry_summaries` is unique on `(user_id, content_hash)`, so two requests for
 * the same entry from one user at the same time (a double-click, or the web
 * client and an MCP client together) both miss the cache lookup and both try to
 * insert the placeholder row. The loser must get the winner's row, not a
 * unique-violation 500.
 *
 * The user is pointed at a Groq model while only the Anthropic server key is
 * set, so both requests fail deterministically at "Groq API key not configured"
 * — past the placeholder insert, with no network call.
 *
 * Nothing here forces the two requests to interleave *inside* the insert
 * window, so this asserts that concurrent requests converge on one row; the
 * narration test of the same shape is the one that reliably reproduces the
 * constraint violation (its cache key is global, so two users collide).
 */
describe("summarization.generate concurrent placeholder creation", () => {
  it("survives two concurrent requests for the same entry", async () => {
    const userId = await createTestUser({
      emailPrefix: "summ",
      summarizationModel: "groq:llama-3.3-70b-versatile",
    });
    createdUserIds.push(userId);
    const contentHash = `hash-${generateUuidv7()}`;
    const entryId = await createVisibleEntry(userId, contentHash);
    const callers = await Promise.all([
      createAuthContext(userId).then(createCaller),
      createAuthContext(userId).then(createCaller),
    ]);

    const results = await Promise.allSettled(
      callers.map((caller) => caller.summarization.generate({ entryId }))
    );

    // Both got as far as the (unconfigured) LLM call rather than a duplicate-key error.
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect(String((result as PromiseRejectedResult).reason)).toContain(
        "Groq API key not configured"
      );
    }
    const rows = await db.select().from(entrySummaries).where(eq(entrySummaries.userId, userId));
    expect(rows).toHaveLength(1);
  });
});
