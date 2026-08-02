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
import {
  users,
  feeds,
  entries,
  subscriptions,
  userEntries,
  entrySummaries,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";
import { CURRENT_PROMPT_VERSION } from "../../src/server/services/summarization";
import { getOrCreateSavedFeed } from "../../src/server/feed/saved-feed";

async function createTestUser(): Promise<string> {
  const userId = generateUuidv7();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `summ-${userId}@test.com`,
    passwordHash: "test-hash",
    // No user API key (it would be encrypted-at-rest); availability comes from the
    // server ANTHROPIC_API_KEY env set in beforeAll. The cached read path returns
    // before any LLM call anyway.
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

/**
 * Creates an entry and makes it reachable the way the app does. The router
 * reads through `visible_entries`, so a `user_entries` row alone isn't enough:
 * an ordinary entry also needs an active subscription (`unsubscribed: true`
 * soft-deletes it, hiding an unstarred entry), while a `saved: true` article
 * lives in the per-user saved feed and is visible on its type alone.
 */
async function createTestEntry(
  userId: string,
  contentHash: string,
  options: { unsubscribed?: boolean; saved?: boolean } = {}
): Promise<string> {
  const entryId = generateUuidv7();
  const now = new Date();
  let feedId: string;
  if (options.saved) {
    feedId = await getOrCreateSavedFeed(db, userId);
  } else {
    feedId = generateUuidv7();
    await db.insert(feeds).values({
      id: feedId,
      type: "web",
      url: `https://example.com/${feedId}.xml`,
      title: "Test Feed",
      lastFetchedAt: now,
      lastEntriesUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(subscriptions).values({
      id: generateUuidv7(),
      userId,
      feedId,
      subscribedAt: now,
      unsubscribedAt: options.unsubscribed ? now : null,
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.insert(entries).values({
    id: entryId,
    feedId,
    type: options.saved ? "saved" : "web",
    guid: `guid-${entryId}`,
    title: "Test Entry",
    contentCleaned: "<p>Some article content to summarize.</p>",
    contentHash,
    fetchedAt: now,
    publishedAt: now,
    // last_seen_at tracks a feed poll, and the entries_last_seen_only_fetched
    // constraint requires it exactly for type='web'.
    lastSeenAt: options.saved ? null : now,
    createdAt: now,
    updatedAt: now,
  });
  // subscription_id is stamped by the user_entries_fill_denormalized trigger.
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

function createAuthContext(userId: string): Context {
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
        expiresAt: new Date(Date.now() + 3600000),
        revokedAt: null,
        lastActiveAt: now,
      },
      user: {
        id: userId,
        email: `${userId}@test.com`,
        emailVerifiedAt: null,
        tosAgreedAt: new Date(),
        privacyPolicyAgreedAt: new Date(),
        notEuAgreedAt: new Date(),
        passwordHash: "test-hash",
        inviteId: null,
        showSpam: false,
        lastActiveAt: null,
        groqApiKey: null,
        anthropicApiKey: null,
        cerebrasApiKey: null,
        summarizationModel: null,
        summarizationMaxWords: null,
        summarizationPrompt: null,
        narrationModel: null,
        savedUnreadCount: 0,
        starredUnreadCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      hasGroqApiKey: false,
      hasAnthropicApiKey: false,
      hasCerebrasApiKey: false,
    },
    apiToken: null,
    authType: "session",
    scopes: [],
    sessionToken: "test-token",
    headers: new Headers(),
  };
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
    userId = await createTestUser();
    createdUserIds.push(userId);
  });

  it("re-sanitizes a cached summary containing disallowed HTML on read", async () => {
    const contentHash = `hash-${generateUuidv7()}`;
    const entryId = await createTestEntry(userId, contentHash);

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

    const caller = createCaller(createAuthContext(userId));
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
    userId = await createTestUser();
    createdUserIds.push(userId);
  });

  // The router reads through `visible_entries`, so it applies exactly the rule
  // the entry list does: a `user_entries` row alone doesn't grant access (#1468).
  it("rejects an entry hidden by visibility even though a user_entries row exists", async () => {
    const entryId = await createTestEntry(userId, `hash-${generateUuidv7()}`, {
      unsubscribed: true,
    });
    const caller = createCaller(createAuthContext(userId));

    await expect(caller.summarization.generate({ entryId })).rejects.toThrow("Entry not found");
  });

  it("rejects another user's entry", async () => {
    const otherUserId = await createTestUser();
    createdUserIds.push(otherUserId);
    const entryId = await createTestEntry(otherUserId, `hash-${generateUuidv7()}`);
    const caller = createCaller(createAuthContext(userId));

    await expect(caller.summarization.generate({ entryId })).rejects.toThrow("Entry not found");
  });

  // ...and the arm of that rule with no subscription row at all still resolves,
  // which is the risk in reading through the view.
  it("summarizes a saved article, which has no subscription row", async () => {
    const contentHash = `hash-${generateUuidv7()}`;
    const entryId = await createTestEntry(userId, contentHash, { saved: true });
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

    const caller = createCaller(createAuthContext(userId));
    const result = await caller.summarization.generate({ entryId, useFullContent: false });

    expect(result.cached).toBe(true);
    expect(result.summary).toContain("Saved article summary");
  });
});
