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
  options: { unsubscribed?: boolean; saved?: boolean } = {}
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

beforeAll(() => {
  // Make summarization "available" via the server key so the router reaches the
  // cached read path (no real LLM call — a cached summary is returned first).
  previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-server-key";
});

afterAll(async () => {
  if (previousAnthropicKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
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
