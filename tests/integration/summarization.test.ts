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

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, userEntries, entrySummaries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import { getAppErrorCode } from "../../src/server/trpc/errors";
import { CURRENT_PROMPT_VERSION } from "../../src/server/services/summarization";
import { DEFAULT_SUMMARIZATION_MODELS } from "../../src/lib/summarization/constants";
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
const PROVIDER_ENV = [
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENROUTER_API_KEY",
  "SUMMARIZATION_MODEL",
  "SERVER_KEY_MODELS",
  "SERVER_KEY_MAX_INPUT_PRICE",
  "SERVER_KEY_MAX_OUTPUT_PRICE",
  "SERVER_KEY_MAX_SPEECH_PRICE",
  "ANTHROPIC_BASE_URL",
  "API_KEY_ENCRYPTION_KEY",
] as const;
const previousEnv = Object.fromEntries(PROVIDER_ENV.map((name) => [name, process.env[name]]));

/**
 * What the stand-in for Anthropic answers every request with, unless a test
 * says otherwise: an error, or for a 200, a summary of `message`.
 */
const PROVIDER_REFUSAL = { status: 400, type: "invalid_request_error", message: "stub refused" };
let providerAnswer = PROVIDER_REFUSAL;
let providerRequests = 0;
let providerStub: Server;

/** Expects `promise` to fail after the router sent the stand-in a request. */
async function expectProviderFailure(promise: Promise<unknown>): Promise<void> {
  const before = providerRequests;
  await expect(promise).rejects.toThrow("Failed to generate summary");
  expect(providerRequests).toBe(before + 1);
}

beforeAll(async () => {
  // Make summarization "available" via the server key so the router reaches the
  // cached read path. Nothing else is configured, so a developer's own keys
  // can't turn a failing generation into a real call; generation goes to a
  // local stand-in for Anthropic that refuses it. The SDK reads
  // ANTHROPIC_BASE_URL when a client is made.
  for (const name of PROVIDER_ENV) delete process.env[name];
  providerStub = createServer((req, res) => {
    providerRequests++;
    req.resume();
    req.on("end", () => {
      res.writeHead(providerAnswer.status, {
        "Content-Type": "application/json",
        // Otherwise the SDK retries a 429/5xx itself, with backoff.
        "x-should-retry": "false",
      });
      res.end(
        JSON.stringify(
          providerAnswer.status === 200
            ? {
                id: "msg_stub",
                type: "message",
                role: "assistant",
                model: "claude-test",
                content: [{ type: "text", text: `<summary>${providerAnswer.message}</summary>` }],
                stop_reason: "end_turn",
                usage: { input_tokens: 1, output_tokens: 1 },
              }
            : {
                type: "error",
                error: { type: providerAnswer.type, message: providerAnswer.message },
              }
        )
      );
    });
  });
  await new Promise<void>((resolve) => providerStub.listen(0, "127.0.0.1", resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(providerStub.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-server-key";
  process.env.API_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

afterAll(async () => {
  await new Promise<void>((resolve) => providerStub.close(() => resolve()));
  for (const name of PROVIDER_ENV) {
    const previous = previousEnv[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
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
 * Once the router gets past the cache, the stand-in provider refuses the
 * request, and reaching that error is itself the proof that the cached summary
 * was not served.
 */
describe("summarization.generate regenerate bypasses the cache", () => {
  async function createUser(): Promise<string> {
    const userId = await createTestUser({ emailPrefix: "summ" });
    createdUserIds.push(userId);
    return userId;
  }

  async function cacheSummary(userId: string, contentHash: string, text: string): Promise<void> {
    await db.insert(entrySummaries).values({
      id: generateUuidv7(),
      userId,
      contentHash,
      summaryText: text,
      modelId: DEFAULT_SUMMARIZATION_MODELS.anthropic,
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

    await expectProviderFailure(caller.summarization.generate({ entryId, regenerate: true }));

    // The failed regeneration leaves the stored summary for the next read.
    const [row] = await db
      .select()
      .from(entrySummaries)
      .where(eq(entrySummaries.userId, userId))
      .limit(1);
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

    await expectProviderFailure(caller.summarization.generate({ entryId, regenerate: true }));
  });
});

/**
 * `entry_summaries` is unique on `(user_id, content_hash)`, so two requests for
 * the same entry from one user at the same time (a double-click, or the web
 * client and an MCP client together) both generate and both write. They must
 * converge on one row, not fail on a unique violation.
 */
describe("summarization.generate concurrent requests", () => {
  afterEach(() => {
    providerAnswer = PROVIDER_REFUSAL;
  });

  it("both succeed and leave one summary", async () => {
    providerAnswer = { status: 200, type: "", message: "Concurrent summary" };
    const userId = await createTestUser({ emailPrefix: "summ" });
    createdUserIds.push(userId);
    const contentHash = `hash-${generateUuidv7()}`;
    const entryId = await createVisibleEntry(userId, contentHash);
    const callers = await Promise.all([
      createAuthContext(userId).then(createCaller),
      createAuthContext(userId).then(createCaller),
    ]);

    const results = await Promise.all(
      callers.map((caller) => caller.summarization.generate({ entryId }))
    );

    // The second request may start after the first stored its summary, and
    // then serves it from the cache.
    expect(results.some((result) => !result.cached)).toBe(true);
    for (const result of results) {
      expect(result.summary).toContain("Concurrent summary");
    }
    const rows = await db.select().from(entrySummaries).where(eq(entrySummaries.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].summaryText).toContain("Concurrent summary");
  });
});

/** Provider failures, answered by the stand-in with the status each test sets. */
describe("summarization.generate provider failures", () => {
  beforeEach(() => {
    providerRequests = 0;
  });

  afterEach(() => {
    providerAnswer = PROVIDER_REFUSAL;
  });

  async function setUp(): Promise<{
    caller: ReturnType<typeof createCaller>;
    entryId: string;
    userId: string;
  }> {
    const userId = await createTestUser({ emailPrefix: "summ" });
    createdUserIds.push(userId);
    const entryId = await createVisibleEntry(userId, `hash-${generateUuidv7()}`);
    return { caller: createCaller(await createAuthContext(userId)), entryId, userId };
  }

  async function failure(promise: Promise<unknown>): Promise<TRPCError> {
    const error = await promise.then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(TRPCError);
    return error as TRPCError;
  }

  it("answers a busy provider as retryable and tries again on the next request", async () => {
    providerAnswer = { status: 529, type: "overloaded_error", message: "Overloaded" };
    const { caller, entryId } = await setUp();

    const error = await failure(caller.summarization.generate({ entryId }));
    expect(error.code).toBe("TOO_MANY_REQUESTS");
    expect(getAppErrorCode(error)).toBe("AI_PROVIDER_BUSY");

    // The app's plain retry (no `regenerate`) reaches the provider.
    await failure(caller.summarization.generate({ entryId }));
    expect(providerRequests).toBe(2);
  });

  it("keeps the provider's message to itself on the server's key", async () => {
    providerAnswer = {
      status: 401,
      type: "authentication_error",
      message: "Key for operator account acct-1234 was revoked",
    };
    const { caller, entryId } = await setUp();

    const error = await failure(caller.summarization.generate({ entryId }));
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(error.message).toBe("Failed to generate summary. Please try again later.");
  });

  it("passes the provider's message on when the user's own key was rejected", async () => {
    providerAnswer = { status: 401, type: "authentication_error", message: "invalid x-api-key" };
    const { caller, entryId } = await setUp();
    await caller.users["me.updatePreferences"]({ apiKeys: { anthropic: "sk-ant-user-key" } });

    const error = await failure(caller.summarization.generate({ entryId }));
    expect(error.code).toBe("BAD_REQUEST");
    expect(getAppErrorCode(error)).toBe("AI_PROVIDER_REJECTED");
    expect(error.message).toBe("Anthropic rejected the request: invalid x-api-key");
  });

  it("records nothing, so the next request tries again and can succeed", async () => {
    providerAnswer = { status: 401, type: "authentication_error", message: "invalid x-api-key" };
    const { caller, entryId, userId } = await setUp();

    await failure(caller.summarization.generate({ entryId }));
    expect(await db.select().from(entrySummaries).where(eq(entrySummaries.userId, userId))).toEqual(
      []
    );

    // The same plain request, straight away: no backoff turns it away.
    await failure(caller.summarization.generate({ entryId }));
    expect(providerRequests).toBe(2);

    providerAnswer = { status: 200, type: "", message: "It worked this time" };
    const result = await caller.summarization.generate({ entryId });
    expect(result.cached).toBe(false);
    expect(result.summary).toContain("It worked this time");
    expect(providerRequests).toBe(3);
  });

  it("says so, without calling anyone, when the user's saved key can't be read", async () => {
    const { caller, entryId } = await setUp();
    await caller.users["me.updatePreferences"]({ apiKeys: { anthropic: "sk-ant-user-key" } });
    const savedUnder = process.env.API_KEY_ENCRYPTION_KEY;
    process.env.API_KEY_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    try {
      const error = await failure(caller.summarization.generate({ entryId }));
      expect(error.code).toBe("BAD_REQUEST");
      expect(getAppErrorCode(error)).toBe("AI_PROVIDER_KEY_UNREADABLE");
      expect(error.message).toBe(
        "Your saved Anthropic API key can't be read; enter it again in Settings."
      );
      // Not quietly on the server's key instead.
      expect(providerRequests).toBe(0);
    } finally {
      process.env.API_KEY_ENCRYPTION_KEY = savedUnder;
    }
  });
});
