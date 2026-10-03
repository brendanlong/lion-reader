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

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "../../src/server/db";
import { users, userEntries, narrationContent, userApiKeys } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import { splitNarrationParagraphs } from "../../src/lib/narration/paragraph-map";
import { NARRATION_FORMAT_VERSION } from "../../src/lib/narration/constants";
import { narrationContentHash } from "../../src/server/services/narration";
import { sanitizeEntryHtml } from "../../src/server/html/sanitize";
import { getOrCreateSavedFeed } from "../../src/server/feed/saved-feed";
import { encryptApiKey } from "../../src/lib/encryption";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestUser,
} from "./helpers";

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

/**
 * Creates an entry and makes it reachable the way the app does. The router
 * reads through `visible_entries`, so a `user_entries` row alone isn't enough:
 * an ordinary entry also needs an active subscription (`unsubscribed: true`
 * soft-deletes it, hiding an unstarred entry), while a `saved: true` article
 * lives in the per-user saved feed and is visible on its type alone.
 */
async function createVisibleEntry(
  userId: string,
  content: {
    contentCleaned?: string;
    contentOriginal?: string;
  },
  options: { unsubscribed?: boolean; saved?: boolean; starred?: boolean } = {}
): Promise<string> {
  const entryId = generateUuidv7();
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
  await createTestEntry(feedId, {
    id: entryId,
    type: options.saved ? "saved" : "web",
    title: "Test Entry",
    contentCleaned: content.contentCleaned ?? null,
    contentOriginal: content.contentOriginal ?? null,
    // Entry content hash is unrelated to the narration cache key (which now
    // hashes the exact narrated content); any stable value works here.
    contentHash: `entry-${entryId}`,
    fetchedAt: now,
  });
  // Not createTestEntry's `userIds`, which can't express `starred` or the
  // explicit change stamps. subscription_id is filled by the
  // user_entries_fill_denormalized trigger.
  await db.insert(userEntries).values({
    userId,
    entryId,
    read: false,
    starred: options.starred ?? false,
    readChangedAt: now,
    starredChangedAt: now,
    updatedAt: now,
  });
  return entryId;
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
    userId = await createTestUser({ emailPrefix: "narr" });
    createdUserIds.push(userId);
  });

  it("returns the persisted paragraph map verbatim on a cache hit", async () => {
    const contentCleaned = "<p>First</p><p>Second</p><p>Third</p>";
    const contentHash = narrationHash(contentCleaned);
    const entryId = await createVisibleEntry(userId, { contentCleaned });

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

    const caller = createCaller(await createAuthContext(userId));
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
    const entryId = await createVisibleEntry(userId, { contentCleaned });

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

    const caller = createCaller(await createAuthContext(userId));
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
    const entryId = await createVisibleEntry(userId, { contentCleaned });
    createdNarrationHashes.push(narrationHash(contentCleaned));

    const caller = createCaller(await createAuthContext(userId));
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
    userId = await createTestUser({ emailPrefix: "narr" });
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
    const entryId = await createVisibleEntry(userId, { contentCleaned, contentOriginal });
    const caller = createCaller(await createAuthContext(userId));

    const cleaned = await caller.narration.generate({ id: entryId });
    expect(cleaned.narration).toBe("Cleaned body paragraph.");

    const original = await caller.narration.generate({ id: entryId, showOriginal: true });
    expect(original.narration).toBe("Original body paragraph.");
  });
});

describe("narration.generate entry visibility", () => {
  let userId: string;

  beforeEach(async () => {
    userId = await createTestUser({ emailPrefix: "narr" });
    createdUserIds.push(userId);
  });

  // The router reads through `visible_entries`, so it applies exactly the rule
  // the entry list does: a `user_entries` row alone doesn't grant access (#1468).
  it("rejects an entry hidden by visibility even though a user_entries row exists", async () => {
    const contentCleaned = "<p>Unsubscribed body paragraph.</p>";
    const entryId = await createVisibleEntry(userId, { contentCleaned }, { unsubscribed: true });
    const caller = createCaller(await createAuthContext(userId));

    await expect(caller.narration.generate({ id: entryId })).rejects.toThrow("Entry not found");
  });

  // ...and the arms of that rule that don't involve an active subscription still
  // narrate, which is the risk in reading through the view: a saved article has
  // no subscription row at all, and a starred entry outlives its subscription.
  it("narrates a saved article, which has no subscription row", async () => {
    const contentCleaned = "<p>Saved article body.</p>";
    createdNarrationHashes.push(narrationHash(contentCleaned));
    const entryId = await createVisibleEntry(userId, { contentCleaned }, { saved: true });
    const caller = createCaller(await createAuthContext(userId));

    const result = await caller.narration.generate({ id: entryId });
    expect(result.narration).toBe("Saved article body.");
  });

  it("narrates a starred entry left behind by an unsubscribe", async () => {
    const contentCleaned = "<p>Starred orphan body.</p>";
    createdNarrationHashes.push(narrationHash(contentCleaned));
    const entryId = await createVisibleEntry(
      userId,
      { contentCleaned },
      { unsubscribed: true, starred: true }
    );
    const caller = createCaller(await createAuthContext(userId));

    const result = await caller.narration.generate({ id: entryId });
    expect(result.narration).toBe("Starred orphan body.");
  });

  it("rejects another user's entry", async () => {
    const otherUserId = await createTestUser({ emailPrefix: "narr" });
    createdUserIds.push(otherUserId);
    const entryId = await createVisibleEntry(otherUserId, {
      contentCleaned: "<p>Someone else's article.</p>",
    });
    const caller = createCaller(await createAuthContext(userId));

    await expect(caller.narration.generate({ id: entryId })).rejects.toThrow("Entry not found");
  });
});

/**
 * The narration cache is deduplicated across users — `narration_content.content_hash`
 * is *globally* unique — so two users narrating the same article at the same
 * time both miss the cache lookup and both try to insert the placeholder row.
 * The loser must get the winner's row, not a unique-violation 500.
 */
describe("narration.generate concurrent placeholder creation", () => {
  it("lets two users narrate the same content at once", async () => {
    // Unique per run so a leftover row from a previous run can't turn this into
    // a cache hit that never reaches the insert.
    const contentCleaned = `<p>Shared article body ${generateUuidv7()}.</p>`;
    const contentHash = narrationHash(contentCleaned);
    createdNarrationHashes.push(contentHash);

    const userIds = await Promise.all([
      createTestUser({ emailPrefix: "narr" }),
      createTestUser({ emailPrefix: "narr" }),
    ]);
    createdUserIds.push(...userIds);

    const callers = await Promise.all(
      userIds.map(async (userId) => {
        const entryId = await createVisibleEntry(userId, { contentCleaned });
        const caller = createCaller(await createAuthContext(userId));
        return { caller, entryId };
      })
    );

    const results = await Promise.all(
      callers.map(({ caller, entryId }) => caller.narration.generate({ id: entryId }))
    );

    for (const result of results) {
      expect(result.narration).toContain("Shared article body");
    }
    // Both requests ended up on the one shared row.
    const rows = await db
      .select()
      .from(narrationContent)
      .where(eq(narrationContent.contentHash, contentHash));
    expect(rows).toHaveLength(1);
  });
});

/**
 * A generate() cache miss calls the LLM, potentially on the server-wide key, so
 * the procedure is on the expensive rate limit like summarization.generate.
 */
describe("narration.generate rate limit", () => {
  it("rejects a burst beyond the expensive limit", async () => {
    const userId = await createTestUser({ emailPrefix: "narr" });
    createdUserIds.push(userId);
    const contentCleaned = `<p>Rate limited body ${generateUuidv7()}.</p>`;
    createdNarrationHashes.push(narrationHash(contentCleaned));
    const entryId = await createVisibleEntry(userId, { contentCleaned });
    const caller = createCaller(await createAuthContext(userId));

    // Fired together so the bucket (10 burst, 1/sec refill) can't refill mid-run.
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () =>
        caller.narration.generate({ id: entryId, useLlmNormalization: false })
      )
    );
    // The burst allowance is served, then the rest are refused.
    expect(results.slice(0, 10).every((r) => r.status === "fulfilled")).toBe(true);
    const rejections = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    expect(rejections.length).toBeGreaterThan(0);
    for (const reason of rejections) {
      expect(String(reason)).toContain("Rate limit exceeded");
    }
  });
});

/**
 * When the model answers but its output is empty or unparseable, the plain-text
 * fallback is served and nothing is cached — but the failure must still be
 * recorded, or every replay of the same article bills the server's key for
 * another LLM call. The record is shared by everyone narrating the content, so
 * a failure that isn't the content's (a busy provider, anything one user's key
 * or model answered) isn't recorded.
 */
describe("narration.generate failure backoff", () => {
  let server: Server;
  let llmRequests = 0;
  let llmContent = "";
  let llmStatus = 200;
  const previousBaseUrl = process.env.GROQ_BASE_URL;
  const previousEncryptionKey = process.env.API_KEY_ENCRYPTION_KEY;
  const previousServerKey = process.env.GROQ_API_KEY;

  beforeAll(async () => {
    process.env.API_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    // A stand-in for Groq's OpenAI-compatible endpoint. The SDK reads
    // GROQ_BASE_URL whenever a per-user client is constructed.
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        llmRequests++;
        if (llmStatus !== 200) {
          // Retry-After 0 so the SDK's own retry doesn't slow the test down.
          res.writeHead(llmStatus, { "Content-Type": "application/json", "Retry-After": "0" });
          res.end(JSON.stringify({ error: { message: "Not now" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 0,
            model: "openai/gpt-oss-120b",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: llmContent },
                finish_reason: "stop",
              },
            ],
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.GROQ_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousBaseUrl === undefined) delete process.env.GROQ_BASE_URL;
    else process.env.GROQ_BASE_URL = previousBaseUrl;
    if (previousEncryptionKey === undefined) delete process.env.API_KEY_ENCRYPTION_KEY;
    else process.env.API_KEY_ENCRYPTION_KEY = previousEncryptionKey;
  });

  beforeEach(() => {
    llmRequests = 0;
    llmStatus = 200;
  });

  afterEach(() => {
    if (previousServerKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousServerKey;
  });

  /** A user without keys of their own, narrating on the server's Groq key. */
  async function createServerKeyUser(): Promise<string> {
    process.env.GROQ_API_KEY = "gsk-server-key";
    const userId = await createTestUser({ emailPrefix: "narr" });
    createdUserIds.push(userId);
    await db
      .update(users)
      .set({ narrationModel: "groq:openai/gpt-oss-120b" })
      .where(eq(users.id, userId));
    return userId;
  }

  /** A user with their own Groq key, narrating with Groq's default model unless told otherwise. */
  async function createGroqUser(narrationModel = "groq:openai/gpt-oss-120b"): Promise<string> {
    const userId = await createTestUser({ emailPrefix: "narr" });
    createdUserIds.push(userId);
    await db.update(users).set({ narrationModel }).where(eq(users.id, userId));
    await db
      .insert(userApiKeys)
      .values({ userId, provider: "groq", encryptedKey: encryptApiKey("gsk-test-key") });
    return userId;
  }

  it.each([
    ["empty", ""],
    ["unparseable", "this is not JSON"],
  ])("records a failure on %s output and doesn't re-call the LLM on replay", async (_, content) => {
    llmContent = content;
    const userId = await createServerKeyUser();
    const contentCleaned = `<p>LLM failure body ${generateUuidv7()}.</p>`;
    const contentHash = narrationHash(contentCleaned);
    createdNarrationHashes.push(contentHash);
    const entryId = await createVisibleEntry(userId, { contentCleaned });
    const caller = createCaller(await createAuthContext(userId));

    const first = await caller.narration.generate({ id: entryId });
    expect(llmRequests).toBe(1);
    expect(first.source).toBe("fallback");
    expect(first.narration).toContain("LLM failure body");

    const [row] = await db
      .select()
      .from(narrationContent)
      .where(eq(narrationContent.contentHash, contentHash));
    expect(row.contentNarration).toBeNull();
    expect(row.errorAt).not.toBeNull();
    expect(row.error).toBeTruthy();

    // A replay within the backoff window serves the fallback without billing
    // another LLM call.
    const second = await caller.narration.generate({ id: entryId });
    expect(llmRequests).toBe(1);
    expect(second.source).toBe("fallback");
    expect(second.narration).toBe(first.narration);
  });

  /** Narrates fresh content once; `pickedModel` is the user's pick, whose row is theirs. */
  async function narrateOnce(
    userId: string,
    pickedModel?: string
  ): Promise<{ row: typeof narrationContent.$inferSelect; source: string }> {
    const contentCleaned = `<p>Not the content's fault ${generateUuidv7()}.</p>`;
    const contentHash = pickedModel
      ? narrationContentHash(sanitizeEntryHtml(contentCleaned) ?? "", {
          userId,
          model: pickedModel,
        })
      : narrationHash(contentCleaned);
    createdNarrationHashes.push(contentHash);
    const entryId = await createVisibleEntry(userId, { contentCleaned });
    const caller = createCaller(await createAuthContext(userId));
    const { source } = await caller.narration.generate({ id: entryId });
    const [row] = await db
      .select()
      .from(narrationContent)
      .where(eq(narrationContent.contentHash, contentHash));
    return { row, source };
  }

  it.each([
    ["busy", 429],
    ["overloaded", 503],
    ["refusing the user's key", 401],
  ])("doesn't back everyone off when the provider is %s", async (_, status) => {
    llmStatus = status;
    const { row, source } = await narrateOnce(await createGroqUser());
    expect(llmRequests).toBeGreaterThan(0);
    expect(source).toBe("fallback");
    expect(row.errorAt).toBeNull();
    expect(row.error).toBeNull();
  });

  it("doesn't back everyone off when the user's own key answers with nothing usable", async () => {
    llmContent = "this is not JSON";
    const { row, source } = await narrateOnce(await createGroqUser());
    expect(llmRequests).toBe(1);
    expect(source).toBe("fallback");
    expect(row.errorAt).toBeNull();
  });

  it("doesn't back everyone off when a model the user picked answers with nothing usable", async () => {
    llmContent = "this is not JSON";
    const picked = "groq:llama-3.3-70b-versatile";
    const { row, source } = await narrateOnce(await createGroqUser(picked), picked);
    expect(llmRequests).toBe(1);
    expect(source).toBe("fallback");
    expect(row.errorAt).toBeNull();
  });

  it("caches a usable response (the fake endpoint reaches the LLM path)", async () => {
    const userId = await createGroqUser();
    const contentCleaned = `<p>LLM success body ${generateUuidv7()}.</p>`;
    createdNarrationHashes.push(narrationHash(contentCleaned));
    llmContent = JSON.stringify({ paragraphs: [{ id: 0, text: "Rewritten by the model." }] });
    const entryId = await createVisibleEntry(userId, { contentCleaned });
    const caller = createCaller(await createAuthContext(userId));

    const first = await caller.narration.generate({ id: entryId });
    expect(first.source).toBe("llm");
    expect(first.narration).toBe("Rewritten by the model.");
    const second = await caller.narration.generate({ id: entryId });
    expect(second.cached).toBe(true);
    expect(llmRequests).toBe(1);
  });

  it("keeps a model one user picked to that user, in both directions", async () => {
    const picked = "groq:llama-3.3-70b-versatile";
    const userA = await createGroqUser(picked);
    const userB = await createGroqUser();
    const contentCleaned = `<p>Shared article ${generateUuidv7()}.</p>`;
    createdNarrationHashes.push(
      narrationHash(contentCleaned),
      narrationContentHash(sanitizeEntryHtml(contentCleaned) ?? "", {
        userId: userA,
        model: picked,
      })
    );
    const narrate = async (userId: string) => {
      const entryId = await createVisibleEntry(userId, { contentCleaned });
      const caller = createCaller(await createAuthContext(userId));
      return () => caller.narration.generate({ id: entryId });
    };
    const [narrateA, narrateB] = [await narrate(userA), await narrate(userB)];
    const answer = (text: string) => JSON.stringify({ paragraphs: [{ id: 0, text }] });

    // A narrates first: B gets the default model's narration, not A's.
    llmContent = answer("What A's model says.");
    expect(await narrateA()).toMatchObject({ narration: "What A's model says.", cached: false });
    llmContent = answer("What the default says.");
    expect(await narrateB()).toMatchObject({ narration: "What the default says.", cached: false });

    // A narrating again reads A's own slot and leaves B's alone.
    llmContent = answer("Something else entirely.");
    expect(await narrateA()).toMatchObject({ narration: "What A's model says.", cached: true });
    expect(await narrateB()).toMatchObject({ narration: "What the default says.", cached: true });
    expect(llmRequests).toBe(2);
  });
});
