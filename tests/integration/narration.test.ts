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
import { db } from "../../src/server/db";
import { users, feeds, entries, userEntries, narrationContent } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";
import { splitNarrationParagraphs } from "../../src/lib/narration/paragraph-map";

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

async function createTestFeedAndEntry(
  contentHash: string,
  contentCleaned: string
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
    contentCleaned,
    contentHash,
    fetchedAt: now,
    publishedAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return entryId;
}

async function createUserEntry(userId: string, entryId: string): Promise<void> {
  const now = new Date();
  await db.insert(userEntries).values({
    userId,
    entryId,
    read: false,
    starred: false,
    readChangedAt: now,
    starredChangedAt: now,
    updatedAt: now,
  });
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
        summarizationModel: null,
        summarizationMaxWords: null,
        summarizationPrompt: null,
        savedUnreadCount: 0,
        starredUnreadCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      hasGroqApiKey: false,
      hasAnthropicApiKey: false,
    },
    apiToken: null,
    authType: "session",
    scopes: [],
    sessionToken: "test-token",
    headers: new Headers(),
  };
}

const createdUserIds: string[] = [];

afterAll(async () => {
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
    const contentHash = `hash-${generateUuidv7()}`;
    const entryId = await createTestFeedAndEntry(
      contentHash,
      "<p>First</p><p>Second</p><p>Third</p>"
    );
    await createUserEntry(userId, entryId);

    // A stored map that is deliberately NOT what naive reconstruction would
    // produce (element 1 dropped, so two narration paragraphs map to o=0 and
    // o=2). If the router reconstructs instead of reading, this won't match.
    const storedMap = [
      { n: 0, o: 0 },
      { n: 1, o: 2 },
    ];
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

  it("re-derives an aligned map for a legacy row with no stored map", async () => {
    const contentHash = `hash-${generateUuidv7()}`;
    // A <br><br>-formatted block: the second <p> holds two paragraphs, exactly
    // the shape that used to desync highlighting.
    const contentCleaned = ["<p>Intro.</p>", "<p>Line one.", "<br /><br />", "Line two.</p>"].join(
      "\n"
    );
    const entryId = await createTestFeedAndEntry(contentHash, contentCleaned);
    await createUserEntry(userId, entryId);

    // Legacy cached row: narration text present, paragraph_map NULL.
    const cachedNarration = "Intro.\n\nLine one.\n\nLine two.";
    await db.insert(narrationContent).values({
      id: generateUuidv7(),
      contentHash,
      contentNarration: cachedNarration,
      paragraphMap: null,
      generatedAt: new Date(),
      createdAt: new Date(),
    });

    const caller = createCaller(createAuthContext(userId));
    const result = await caller.narration.generate({ id: entryId, useLlmNormalization: true });

    expect(result.cached).toBe(true);
    // The re-derived map is aligned with the player's paragraph split: one entry
    // per paragraph, and the two paragraphs from the second <p> both point at it.
    const segments = splitNarrationParagraphs(result.narration);
    expect(result.paragraphMap.length).toBe(segments.length);
    expect(result.paragraphMap).toEqual([
      { n: 0, o: 0 },
      { n: 1, o: 1 },
      { n: 2, o: 1 },
    ]);
  });
});
