// Set ADMIN_SECRET before any imports so env.ts reads it at module init time
process.env.ADMIN_SECRET = "test-admin-secret";

/**
 * Integration tests for the Admin tRPC router.
 *
 * These tests use a real database to verify admin operations:
 * invite management, feed health monitoring, and user listing.
 * All endpoints require ALLOWLIST_SECRET Bearer token authentication.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  subscriptions,
  invites,
  jobs,
  sessions,
  apiTokens,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";
import { createTestFeed, createTestUser, createUnauthContext } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// Test Helpers
// ============================================================================

const createAdminContext = (): Context =>
  createUnauthContext(new Headers({ authorization: "Bearer test-admin-secret" }));

const createWrongTokenContext = (): Context =>
  createUnauthContext(new Headers({ authorization: "Bearer wrong-secret" }));

/**
 * Creates a test invite directly in the database.
 */
async function createTestInvite(
  options: {
    expiresAt?: Date;
    usedAt?: Date | null;
    usedByUserId?: string | null;
  } = {}
): Promise<{ id: string; token: string }> {
  const id = generateUuidv7();
  const token = `test-token-${id}`;
  const now = new Date();
  const expiresAt = options.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(invites).values({
    id,
    token,
    expiresAt,
    usedAt: options.usedAt ?? null,
    usedByUserId: options.usedByUserId ?? null,
    createdAt: now,
  });

  return { id, token };
}

// ============================================================================
// Tests
// ============================================================================

describe("Admin API", () => {
  async function cleanup(): Promise<void> {
    // Clear in dependency order
    await db.delete(jobs);
    await db.delete(subscriptions);
    // Clear invite references from users first
    await db.execute(sql`UPDATE users SET invite_id = NULL`);
    await db.delete(invites);
    await db.delete(feeds);
    await db.delete(users);
  }

  beforeEach(cleanup);
  afterAll(cleanup);

  // ==========================================================================
  // Security Tests
  // ==========================================================================

  describe("security", () => {
    it("fails without auth header", async () => {
      const caller = createCaller(createUnauthContext());

      await expect(caller.admin.listUsers()).rejects.toThrow("Invalid admin secret");
    });

    it("fails with wrong token", async () => {
      const caller = createCaller(createWrongTokenContext());

      await expect(caller.admin.listUsers()).rejects.toThrow("Invalid admin secret");
    });
  });

  // ==========================================================================
  // Invite Tests
  // ==========================================================================

  describe("admin.createInvite", () => {
    it("creates an invite and returns URL", async () => {
      const caller = createCaller(createAdminContext());

      const result = await caller.admin.createInvite();

      expect(result.invite).toBeDefined();
      expect(result.invite.id).toBeDefined();
      expect(result.invite.token).toBeDefined();
      expect(result.invite.expiresAt).toBeInstanceOf(Date);
      expect(result.inviteUrl).toContain(result.invite.token);
      expect(result.inviteUrl).toContain("/register?invite=");

      // Verify invite was persisted in database
      const [dbInvite] = await db.select().from(invites).where(eq(invites.id, result.invite.id));
      expect(dbInvite).toBeDefined();
      expect(dbInvite.token).toBe(result.invite.token);
    });
  });

  describe("admin.listInvites", () => {
    it("lists invites with pagination", async () => {
      const caller = createCaller(createAdminContext());

      // Create several invites
      await createTestInvite();
      await createTestInvite();
      await createTestInvite();

      const result = await caller.admin.listInvites({ limit: 2 });

      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).toBeDefined();

      // Fetch next page
      const page2 = await caller.admin.listInvites({
        limit: 2,
        cursor: result.nextCursor,
      });

      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeUndefined();
    });

    it("resumes after the boundary invite is deleted", async () => {
      const caller = createCaller(createAdminContext());

      const created = [
        await createTestInvite(),
        await createTestInvite(),
        await createTestInvite(),
      ];
      // Same-millisecond UUIDv7s needn't sort in creation order; the list sorts by id.
      const lowestId = created.map((i) => i.id).sort()[0];

      const page1 = await caller.admin.listInvites({ limit: 2 });
      await db.delete(invites).where(eq(invites.id, page1.items[1].id));

      const page2 = await caller.admin.listInvites({ limit: 2, cursor: page1.nextCursor });
      expect(page2.items.map((i) => i.id)).toEqual([lowestId]);
    });

    it("rejects a malformed cursor as a validation error", async () => {
      const caller = createCaller(createAdminContext());
      await expect(caller.admin.listInvites({ cursor: "not-a-cursor" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("searches invites by used-by user email", async () => {
      const caller = createCaller(createAdminContext());

      // Create a user and an invite used by that user
      const userId = await createTestUser({ emailPrefix: "searchable" });
      const usedInvite = await createTestInvite({
        usedAt: new Date(),
        usedByUserId: userId,
      });

      // Create another unused invite
      await createTestInvite();

      // Search by the user's email substring
      const result = await caller.admin.listInvites({ search: "searchable" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(usedInvite.id);
      expect(result.items[0].status).toBe("used");
      expect(result.items[0].usedByEmail).toContain("searchable");
    });
  });

  describe("admin.revokeInvite", () => {
    it("revokes an unused invite", async () => {
      const caller = createCaller(createAdminContext());

      const invite = await createTestInvite();

      const result = await caller.admin.revokeInvite({ inviteId: invite.id });

      expect(result.success).toBe(true);

      // Verify invite was deleted from database
      const [dbInvite] = await db.select().from(invites).where(eq(invites.id, invite.id));
      expect(dbInvite).toBeUndefined();
    });
  });

  // ==========================================================================
  // Feed Health Tests
  // ==========================================================================

  describe("admin.listFeeds", () => {
    it("lists all web feeds", async () => {
      const caller = createCaller(createAdminContext());

      const feedId1 = await createTestFeed({ url: "https://example.com/feed1.xml" });
      const feedId2 = await createTestFeed({ url: "https://example.com/feed2.xml" });

      const result = await caller.admin.listFeeds();

      expect(result.items.length).toBeGreaterThanOrEqual(2);

      const feedIds = result.items.map((f) => f.feedId);
      expect(feedIds).toContain(feedId1);
      expect(feedIds).toContain(feedId2);
    });

    it("filters by URL substring", async () => {
      const caller = createCaller(createAdminContext());

      await createTestFeed({ url: "https://example.com/unique-feed-abc.xml" });
      await createTestFeed({ url: "https://other.com/different.xml" });

      const result = await caller.admin.listFeeds({ urlFilter: "unique-feed-abc" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].url).toContain("unique-feed-abc");
    });

    it("filters by broken only", async () => {
      const caller = createCaller(createAdminContext());

      await createTestFeed({
        url: "https://example.com/healthy.xml",
        consecutiveFailures: 0,
      });
      const brokenId = await createTestFeed({
        url: "https://example.com/broken.xml",
        consecutiveFailures: 5,
        lastError: "Connection timeout",
      });

      const result = await caller.admin.listFeeds({ brokenOnly: true });

      // All returned feeds should have consecutiveFailures > 0
      for (const feed of result.items) {
        expect(feed.consecutiveFailures).toBeGreaterThan(0);
      }

      const feedIds = result.items.map((f) => f.feedId);
      expect(feedIds).toContain(brokenId);
    });
  });

  describe("admin.listFeeds pagination", () => {
    // The keyset cursor compares COALESCE(title, ''), so the ORDER BY has to
    // do the same: with a bare `ASC` (Postgres NULLS LAST) an untitled feed
    // sorts after every titled one while the cursor puts it first, and it
    // becomes unreachable past the first page. Untitled feeds are exactly the
    // never-successfully-fetched ones this admin page exists to surface.
    it("reaches an untitled feed while paging", async () => {
      const caller = createCaller(createAdminContext());

      const untitledId = await createTestFeed({
        url: "https://example.com/untitled.xml",
        title: null,
        consecutiveFailures: 0,
      });
      const alphaId = await createTestFeed({
        url: "https://example.com/alpha.xml",
        title: "Alpha",
        consecutiveFailures: 0,
      });
      const zetaId = await createTestFeed({
        url: "https://example.com/zeta.xml",
        title: "Zeta",
        consecutiveFailures: 0,
      });

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await caller.admin.listFeeds({ limit: 1, cursor });
        seen.push(...result.items.map((f) => f.feedId));
        cursor = result.nextCursor;
        if (!cursor) break;
      }

      // Untitled first (COALESCE(title, '') sorts '' before every title), then
      // alphabetically — and every feed is returned exactly once.
      expect(seen).toEqual([untitledId, alphaId, zetaId]);
    });

    it("resumes after the boundary feed is deleted", async () => {
      const caller = createCaller(createAdminContext());

      await createTestFeed({ url: "https://example.com/a.xml", title: "Alpha" });
      const boundaryId = await createTestFeed({ url: "https://example.com/b.xml", title: "Beta" });
      const lastId = await createTestFeed({ url: "https://example.com/c.xml", title: "Gamma" });

      const page1 = await caller.admin.listFeeds({ limit: 2 });
      expect(page1.items[1].feedId).toBe(boundaryId);
      await db.delete(feeds).where(eq(feeds.id, boundaryId));

      const page2 = await caller.admin.listFeeds({ limit: 2, cursor: page1.nextCursor });
      expect(page2.items.map((f) => f.feedId)).toEqual([lastId]);
    });

    it("rejects a malformed cursor as a validation error", async () => {
      const caller = createCaller(createAdminContext());
      await expect(caller.admin.listFeeds({ cursor: generateUuidv7() })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });
  });

  describe("admin.getOverview", () => {
    it("counts active users in the 7- and 30-day windows", async () => {
      const caller = createCaller(createAdminContext());

      const now = Date.now();
      await createTestUser({ emailPrefix: "recent", lastActiveAt: new Date(now - 3 * DAY_MS) });
      await createTestUser({ emailPrefix: "midway", lastActiveAt: new Date(now - 20 * DAY_MS) });
      await createTestUser({ emailPrefix: "stale", lastActiveAt: new Date(now - 40 * DAY_MS) });
      // Never active: excluded from both windows (NULL fails the > comparison).
      await createTestUser({ emailPrefix: "never", lastActiveAt: null });

      const stats = await caller.admin.getOverview();

      expect(stats.totalUsers).toBe(4);
      expect(stats.activeUsersLast7Days).toBe(1);
      expect(stats.activeUsersLast30Days).toBe(2);
    });
  });

  describe("admin.retryFeedFetch", () => {
    it("resets feed failure count and schedules immediate fetch", async () => {
      const caller = createCaller(createAdminContext());

      const feedId = await createTestFeed({
        url: "https://example.com/retry-test.xml",
        consecutiveFailures: 10,
        lastError: "Server error",
      });

      const result = await caller.admin.retryFeedFetch({ feedId });

      expect(result.success).toBe(true);

      // Verify feed was updated in database
      const [updatedFeed] = await db.select().from(feeds).where(eq(feeds.id, feedId));

      expect(updatedFeed.consecutiveFailures).toBe(0);
      expect(updatedFeed.lastError).toBeNull();
      expect(updatedFeed.nextFetchAt).toBeDefined();
    });
  });

  // ==========================================================================
  // User Tests
  // ==========================================================================

  describe("admin.listUsers", () => {
    it("lists all users", async () => {
      const caller = createCaller(createAdminContext());

      const userId1 = await createTestUser({ emailPrefix: "user-a" });
      const userId2 = await createTestUser({ emailPrefix: "user-b" });

      const result = await caller.admin.listUsers();

      expect(result.items.length).toBeGreaterThanOrEqual(2);

      const userIds = result.items.map((u) => u.id);
      expect(userIds).toContain(userId1);
      expect(userIds).toContain(userId2);

      // Verify response shape
      const user = result.items.find((u) => u.id === userId1);
      expect(user).toBeDefined();
      expect(user!.email).toContain("user-a");
      expect(user!.createdAt).toBeInstanceOf(Date);
      expect(Array.isArray(user!.providers)).toBe(true);
      expect(typeof user!.subscriptionCount).toBe("number");
      expect(typeof user!.entryCount).toBe("number");
    });

    it("searches by email", async () => {
      const caller = createCaller(createAdminContext());

      await createTestUser({ emailPrefix: "findme-unique" });
      await createTestUser({ emailPrefix: "other-user" });

      const result = await caller.admin.listUsers({ search: "findme-unique" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].email).toContain("findme-unique");
    });

    it("returns lastActiveAt from the denormalized user column", async () => {
      const caller = createCaller(createAdminContext());

      const userId = await createTestUser({ emailPrefix: "active-user" });

      const activeTime = new Date("2026-03-15T12:00:00Z");
      await db.update(users).set({ lastActiveAt: activeTime }).where(eq(users.id, userId));

      const result = await caller.admin.listUsers({ search: "active-user" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].lastActiveAt).toBeInstanceOf(Date);
      expect(result.items[0].lastActiveAt!.getTime()).toBe(activeTime.getTime());
    });

    it("keeps lastActiveAt after the user's sessions are cleaned up", async () => {
      // Regression: activity used to be derived from MAX(sessions.last_active_at),
      // so retention cleanup deleting expired sessions blanked it out. It now
      // lives on the user row and must survive with no sessions at all.
      const caller = createCaller(createAdminContext());

      const userId = await createTestUser({ emailPrefix: "retained-user" });
      const activeTime = new Date("2026-02-01T09:00:00Z");
      await db.update(users).set({ lastActiveAt: activeTime }).where(eq(users.id, userId));

      // Create then delete a session, simulating retention cleanup.
      const sessionId = generateUuidv7();
      await db.insert(sessions).values({
        id: sessionId,
        userId,
        tokenHash: `test-hash-${sessionId}`,
        expiresAt: new Date("2026-03-03T09:00:00Z"),
        lastActiveAt: activeTime,
      });
      await db.delete(sessions).where(eq(sessions.id, sessionId));

      const result = await caller.admin.listUsers({ search: "retained-user" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].lastActiveAt).toBeInstanceOf(Date);
      expect(result.items[0].lastActiveAt!.getTime()).toBe(activeTime.getTime());
    });

    it("reports most recent token use separately from session activity", async () => {
      const caller = createCaller(createAdminContext());

      const userId = await createTestUser({ emailPrefix: "token-user" });

      // Session activity and token use are independent signals.
      const sessionTime = new Date("2026-04-01T00:00:00Z");
      await db.update(users).set({ lastActiveAt: sessionTime }).where(eq(users.id, userId));

      const tokenUsedTime = new Date("2026-05-20T00:00:00Z");
      await db.insert(apiTokens).values({
        id: generateUuidv7(),
        userId,
        tokenHash: `token-hash-${userId}`,
        scopes: ["mcp"],
        lastUsedAt: tokenUsedTime,
      });

      const result = await caller.admin.listUsers({ search: "token-user" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].lastActiveAt!.getTime()).toBe(sessionTime.getTime());
      expect(result.items[0].lastTokenUsedAt).toBeInstanceOf(Date);
      expect(result.items[0].lastTokenUsedAt!.getTime()).toBe(tokenUsedTime.getTime());
    });

    it("reports scoped (Google Reader) session activity as token use, not session activity", async () => {
      // A native app polling the Google Reader compat API holds a scoped
      // session (scopes IS NOT NULL). That polling bumps only
      // sessions.last_active_at, never users.last_active_at, so it must surface
      // as lastTokenUsedAt ("last API usage") and leave lastActiveAt untouched.
      const caller = createCaller(createAdminContext());

      const userId = await createTestUser({ emailPrefix: "greader-user" });

      // No full-access session activity: users.last_active_at stays NULL.
      const scopedActiveTime = new Date("2026-05-25T00:00:00Z");
      await db.insert(sessions).values({
        id: generateUuidv7(),
        userId,
        tokenHash: `greader-hash-${userId}`,
        scopes: ["reader:full-access"],
        expiresAt: new Date("2026-06-24T00:00:00Z"),
        lastActiveAt: scopedActiveTime,
      });

      const result = await caller.admin.listUsers({ search: "greader-user" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].lastActiveAt).toBeNull();
      expect(result.items[0].lastTokenUsedAt).toBeInstanceOf(Date);
      expect(result.items[0].lastTokenUsedAt!.getTime()).toBe(scopedActiveTime.getTime());
    });

    it("ignores full-access session rows when computing token use", async () => {
      // A normal browser session (scopes NULL) must NOT count toward
      // lastTokenUsedAt — only scoped sessions do.
      const caller = createCaller(createAdminContext());

      const userId = await createTestUser({ emailPrefix: "browser-only-user" });
      await db.insert(sessions).values({
        id: generateUuidv7(),
        userId,
        tokenHash: `browser-hash-${userId}`,
        scopes: null,
        expiresAt: new Date("2026-06-24T00:00:00Z"),
        lastActiveAt: new Date("2026-05-25T00:00:00Z"),
      });

      const result = await caller.admin.listUsers({ search: "browser-only-user" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].lastTokenUsedAt).toBeNull();
    });

    it("returns null token use for users who never used a token", async () => {
      const caller = createCaller(createAdminContext());

      await createTestUser({ emailPrefix: "no-token-user" });

      const result = await caller.admin.listUsers({ search: "no-token-user" });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].lastTokenUsedAt).toBeNull();
    });

    it("sorts by most recent activity by default, nulls last", async () => {
      const caller = createCaller(createAdminContext());

      const idNever = await createTestUser({ emailPrefix: "sort-never" });
      const idOld = await createTestUser({ emailPrefix: "sort-old" });
      const idRecent = await createTestUser({ emailPrefix: "sort-recent" });

      await db
        .update(users)
        .set({ lastActiveAt: new Date("2026-01-01T00:00:00Z") })
        .where(eq(users.id, idOld));
      await db
        .update(users)
        .set({ lastActiveAt: new Date("2026-06-01T00:00:00Z") })
        .where(eq(users.id, idRecent));
      // idNever keeps a null lastActiveAt.

      const result = await caller.admin.listUsers({ search: "sort-" });

      const order = result.items.map((u) => u.id);
      expect(order).toEqual([idRecent, idOld, idNever]);
    });

    it("sorts by email A→Z", async () => {
      const caller = createCaller(createAdminContext());

      // Emails are prefixed with the UUIDv7 id, so create then rewrite them to
      // control alphabetical order independently of creation order.
      const id1 = await createTestUser({ emailPrefix: "email-sort" });
      const id2 = await createTestUser({ emailPrefix: "email-sort" });
      await db.update(users).set({ email: "zzz-emailsort@test.com" }).where(eq(users.id, id1));
      await db.update(users).set({ email: "aaa-emailsort@test.com" }).where(eq(users.id, id2));

      const result = await caller.admin.listUsers({ search: "emailsort", sort: "email" });

      expect(result.items.map((u) => u.id)).toEqual([id2, id1]);
    });

    it("paginates a sorted list without overlap", async () => {
      const caller = createCaller(createAdminContext());

      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await createTestUser({ emailPrefix: "activity-page" });
        ids.push(id);
        await db
          .update(users)
          .set({ lastActiveAt: new Date(`2026-0${i + 1}-01T00:00:00Z`) })
          .where(eq(users.id, id));
      }

      const page1 = await caller.admin.listUsers({ search: "activity-page", limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeDefined();

      const page2 = await caller.admin.listUsers({
        search: "activity-page",
        limit: 2,
        cursor: page1.nextCursor,
      });

      const page1Ids = new Set(page1.items.map((u) => u.id));
      for (const user of page2.items) {
        expect(page1Ids.has(user.id)).toBe(false);
      }

      // Most-recent first across both pages.
      const combined = [...page1.items, ...page2.items].filter((u) => ids.includes(u.id));
      expect(combined.map((u) => u.id)).toEqual([ids[2], ids[1], ids[0]]);
    });

    it("pagination works", async () => {
      const caller = createCaller(createAdminContext());

      // Create enough users to paginate
      await createTestUser({ emailPrefix: "page-a" });
      await createTestUser({ emailPrefix: "page-b" });
      await createTestUser({ emailPrefix: "page-c" });

      const page1 = await caller.admin.listUsers({ limit: 2 });

      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeDefined();

      const page2 = await caller.admin.listUsers({
        limit: 2,
        cursor: page1.nextCursor,
      });

      expect(page2.items.length).toBeGreaterThanOrEqual(1);

      // Verify no overlap between pages
      const page1Ids = new Set(page1.items.map((u) => u.id));
      for (const user of page2.items) {
        expect(page1Ids.has(user.id)).toBe(false);
      }
    });

    it.each(["activity", "email", "created", "oldest"] as const)(
      "resumes after the boundary user is deleted (sort: %s)",
      async (sort) => {
        const caller = createCaller(createAdminContext());

        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
          const id = await createTestUser({ emailPrefix: "deleted-boundary" });
          await db
            .update(users)
            .set({ lastActiveAt: new Date(`2026-0${i + 1}-01T00:00:00Z`) })
            .where(eq(users.id, id));
          ids.push(id);
        }

        const page1 = await caller.admin.listUsers({ search: "deleted-boundary", sort, limit: 2 });
        const boundaryId = page1.items[1].id;
        await db.delete(users).where(eq(users.id, boundaryId));

        const page2 = await caller.admin.listUsers({
          search: "deleted-boundary",
          sort,
          limit: 2,
          cursor: page1.nextCursor,
        });
        const expectedRemaining = ids.filter(
          (id) => !page1.items.some((u) => u.id === id) && id !== boundaryId
        );
        expect(page2.items.map((u) => u.id)).toEqual(expectedRemaining);
      }
    );

    // A Date cursor would truncate to milliseconds and skip a row sharing the
    // boundary's millisecond but sorting after it on sub-millisecond activity.
    it("keeps microsecond precision in the activity cursor", async () => {
      const caller = createCaller(createAdminContext());

      const later = await createTestUser({ emailPrefix: "micro" });
      const earlier = await createTestUser({ emailPrefix: "micro" });
      await db.execute(
        sql`UPDATE users SET last_active_at = '2026-05-01T00:00:00.000900Z' WHERE id = ${later}`
      );
      await db.execute(
        sql`UPDATE users SET last_active_at = '2026-05-01T00:00:00.000100Z' WHERE id = ${earlier}`
      );

      const page1 = await caller.admin.listUsers({ search: "micro", limit: 1 });
      expect(page1.items.map((u) => u.id)).toEqual([later]);

      const page2 = await caller.admin.listUsers({
        search: "micro",
        limit: 1,
        cursor: page1.nextCursor,
      });
      expect(page2.items.map((u) => u.id)).toEqual([earlier]);
    });

    it("rejects a cursor from a different sort", async () => {
      const caller = createCaller(createAdminContext());

      await createTestUser({ emailPrefix: "mismatch" });
      await createTestUser({ emailPrefix: "mismatch" });

      const page1 = await caller.admin.listUsers({ search: "mismatch", sort: "email", limit: 1 });
      await expect(
        caller.admin.listUsers({ search: "mismatch", sort: "activity", cursor: page1.nextCursor })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });
});
