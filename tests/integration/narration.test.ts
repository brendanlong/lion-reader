/**
 * Integration tests for the narration router's cached read path.
 *
 * The paragraph map translates a narration paragraph index (what the TTS player
 * reports as it speaks) into the `data-para-id` of the block element to
 * highlight. It is persisted alongside the cached narration text so a cache hit
 * returns the exact alignment produced at generation time. Previously the map
 * was reconstructed on every cache hit by positionally pairing the source's
 * block elements with the cached narration's paragraphs, which silently
 * mis-mapped whenever a block's narration text spanned multiple paragraphs
 * (e.g. <br><br>-encoded articles) or the LLM dropped a paragraph.
 *
 * These tests lock in:
 *  1. a persisted map is returned verbatim on a cache hit;
 *  2. a legacy row (no stored map) still yields a map aligned with how the
 *     player splits the narration text — length(map) === length(split).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  entries,
  subscriptions,
  userEntries,
  narrationContent,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";
import { splitNarrationParagraphs } from "../../src/lib/narration/paragraph-map";
import { NARRATION_FORMAT_VERSION } from "../../src/lib/narration/constants";
import { sanitizeEntryHtml } from "../../src/server/html/sanitize";

/**
 * The narration cache key, mirroring the router: the narration format plus the
 * exact content being narrated, which is the *sanitized* content — the raw
 * columns hold markup the page never renders. A mismatch here shows up as the
 * "serves the stored map verbatim" test missing the cache.
 */
function narrationHash(content: string, format = NARRATION_FORMAT_VERSION): string {
  return createHash("sha256")
    .update(`${format}\n${sanitizeEntryHtml(content) ?? ""}`, "utf8")
    .digest("hex");
}

async function createTestUser(): Promise<string> {
  const userId = generateUuidv7();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `narr-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

/**
 * Creates a feed + entry and makes it visible to the user the way the app does:
 * an active subscription plus the `user_entries` row that grants visibility.
 * The router reads through `visible_entries`, so both are required —
 * `unsubscribed: true` leaves the subscription soft-deleted, which hides an
 * unstarred entry from that view.
 */
async function createTestEntry(
  userId: string,
  content: {
    contentCleaned?: string;
    contentOriginal?: string;
  },
  options: { unsubscribed?: boolean } = {}
): Promise<string> {
  const feedId = generateUuidv7();
  const entryId = generateUuidv7();
  const now = new Date();
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
  await db.insert(entries).values({
    id: entryId,
    feedId,
    type: "web",
    guid: `guid-${entryId}`,
    title: "Test Entry",
    contentCleaned: content.contentCleaned ?? null,
    contentOriginal: content.contentOriginal ?? null,
    // Entry content hash is unrelated to the narration cache key (which now
    // hashes the exact narrated content); any stable value works here.
    contentHash: `entry-${entryId}`,
    fetchedAt: now,
    publishedAt: now,
    lastSeenAt: now,
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
// narration_content is keyed by a content_hash derived from fixed test content,
// not the per-test user, so it isn't cleaned up by deleting users. Track the
// hashes we insert and delete them, or a second run against the same DB collides
// on the content_hash unique constraint (issue #1210).
const createdNarrationHashes: string[] = [];

afterAll(async () => {
  for (const contentHash of createdNarrationHashes) {
    await db.delete(narrationContent).where(eq(narrationContent.contentHash, contentHash));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("narration.generate cached read path", () => {
  let userId: string;

  beforeEach(async () => {
    userId = await createTestUser();
    createdUserIds.push(userId);
  });

  it("returns the persisted paragraph map verbatim on a cache hit", async () => {
    const contentCleaned = "<p>First</p><p>Second</p><p>Third</p>";
    const contentHash = narrationHash(contentCleaned);
    const entryId = await createTestEntry(userId, { contentCleaned });

    // A stored map that is deliberately NOT what naive reconstruction would
    // produce (element 1 dropped, so two narration paragraphs map to o=0 and
    // o=2). If the router reconstructs instead of reading, this won't match.
    const storedMap = [
      { n: 0, o: 0 },
      { n: 1, o: 2 },
    ];
    createdNarrationHashes.push(contentHash);
    await db.insert(narrationContent).values({
      id: generateUuidv7(),
      contentHash,
      contentNarration: "First\n\nThird",
      paragraphMap: storedMap,
      generatedAt: new Date(),
      createdAt: new Date(),
    });

    const caller = createCaller(createAuthContext(userId));
    const result = await caller.narration.generate({ id: entryId, useLlmNormalization: true });

    expect(result.cached).toBe(true);
    expect(result.paragraphMap).toEqual(storedMap);
  });

  it("does not serve a row an older narration format wrote", async () => {
    // A <br><br>-formatted block: the second <p> holds two paragraphs, exactly
    // the shape that used to desync highlighting.
    const contentCleaned = ["<p>Intro.</p>", "<p>Line one.", "<br /><br />", "Line two.</p>"].join(
      "\n"
    );
    const entryId = await createTestEntry(userId, { contentCleaned });

    // Keyed by the previous format. Its map numbers elements the way that walk
    // numbered them, so serving it against today's `data-para-id`s would
    // highlight the wrong paragraphs — the format is in the cache key so this
    // row is simply never found. Regeneration falls back to plain text, there
    // being no LLM key configured here.
    const staleHash = narrationHash(contentCleaned, NARRATION_FORMAT_VERSION - 1);
    const cachedNarration = "Stale narration text.";
    createdNarrationHashes.push(staleHash, narrationHash(contentCleaned));
    await db.insert(narrationContent).values({
      id: generateUuidv7(),
      contentHash: staleHash,
      contentNarration: cachedNarration,
      paragraphMap: [{ n: 0, o: 0 }],
      generatedAt: new Date(),
      createdAt: new Date(),
    });

    const caller = createCaller(createAuthContext(userId));
    const result = await caller.narration.generate({ id: entryId, useLlmNormalization: true });

    expect(result.cached).toBe(false);
    expect(result.narration).not.toBe(cachedNarration);
    // And what it returns instead is aligned with the player's paragraph split:
    // one entry per paragraph, the two halves of the <br><br> block both
    // pointing at the <p> that holds them.
    const segments = splitNarrationParagraphs(result.narration);
    expect(result.paragraphMap.length).toBe(segments.length);
    expect(result.paragraphMap).toEqual([
      { n: 0, o: 0 },
      { n: 1, o: 1 },
      { n: 2, o: 1 },
    ]);
  });

  it("narrates the sanitized content, not the raw columns", async () => {
    // Sanitization is read-path-only, so the raw columns hold markup the page
    // never renders: a stylesheet narration would otherwise read aloud, and a
    // lazy-loading `<noscript><img>` whose element the client never numbers,
    // which would shift every paragraph after it onto the wrong one.
    const contentCleaned = [
      "<style>.byline{color:#333}</style>",
      "<p>Real article text.</p>",
      '<figure><img src="https://example.com/cat.jpg" alt="A cat">',
      '<noscript><img src="https://example.com/cat.jpg" alt="A cat"></noscript>',
      "<figcaption>My cat</figcaption></figure>",
      "<p>The end.</p>",
    ].join("");
    const entryId = await createTestEntry(userId, { contentCleaned });
    createdNarrationHashes.push(narrationHash(contentCleaned));

    const caller = createCaller(createAuthContext(userId));
    const result = await caller.narration.generate({ id: entryId, useLlmNormalization: false });

    expect(splitNarrationParagraphs(result.narration)).toEqual([
      "Real article text.",
      "Image: A cat. My cat",
      "The end.",
    ]);
    // p, figure, p — numbered over the sanitized HTML the client marks up, with
    // no gap where the dropped markup was.
    expect(result.paragraphMap).toEqual([
      { n: 0, o: 0 },
      { n: 1, o: 1 },
      { n: 2, o: 4 },
    ]);
  });
});

describe("narration.generate narrates the displayed variant", () => {
  let userId: string;

  beforeEach(async () => {
    userId = await createTestUser();
    createdUserIds.push(userId);
  });

  // No Groq key in the unit/integration env, so generate() takes the fallback
  // (plain-text) path — its narration text is exactly the selected variant's
  // text, which lets us assert *which* variant was narrated.
  it("narrates cleaned content by default and original content when showOriginal is set", async () => {
    const contentCleaned = "<p>Cleaned body paragraph.</p>";
    const contentOriginal = "<p>Original body paragraph.</p>";
    // generate() inserts a placeholder narration_content row on a cache miss
    // (keyed by the hash of the narrated content), so both variants must be
    // cleaned up too — the check-then-insert doesn't collide on re-run, but we
    // still don't want to leave rows behind (issue #1210).
    createdNarrationHashes.push(narrationHash(contentCleaned), narrationHash(contentOriginal));
    const entryId = await createTestEntry(userId, { contentCleaned, contentOriginal });
    const caller = createCaller(createAuthContext(userId));

    const cleaned = await caller.narration.generate({ id: entryId });
    expect(cleaned.narration).toBe("Cleaned body paragraph.");

    const original = await caller.narration.generate({ id: entryId, showOriginal: true });
    expect(original.narration).toBe("Original body paragraph.");
  });
});

describe("narration.generate entry visibility", () => {
  let userId: string;

  beforeEach(async () => {
    userId = await createTestUser();
    createdUserIds.push(userId);
  });

  // The router reads through `visible_entries`, so it applies exactly the rule
  // the entry list does: a `user_entries` row alone doesn't grant access (#1468).
  it("rejects an entry hidden by visibility even though a user_entries row exists", async () => {
    const contentCleaned = "<p>Unsubscribed body paragraph.</p>";
    const entryId = await createTestEntry(userId, { contentCleaned }, { unsubscribed: true });
    const caller = createCaller(createAuthContext(userId));

    await expect(caller.narration.generate({ id: entryId })).rejects.toThrow("Entry not found");
  });

  it("rejects another user's entry", async () => {
    const otherUserId = await createTestUser();
    createdUserIds.push(otherUserId);
    const entryId = await createTestEntry(otherUserId, {
      contentCleaned: "<p>Someone else's article.</p>",
    });
    const caller = createCaller(createAuthContext(userId));

    await expect(caller.narration.generate({ id: entryId })).rejects.toThrow("Entry not found");
  });
});
