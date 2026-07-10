/**
 * Integration tests for the retention cleanup service (run by the daily
 * `cleanup` singleton job).
 *
 * Verifies that expired/long-revoked credentials and parked one-time jobs are
 * deleted, and — just as importantly — that live rows are left alone.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../../src/server/db";
import {
  apiTokens,
  feeds,
  jobs,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthConsentGrants,
  oauthRefreshTokens,
  opmlImports,
  sessions,
  subscriptions,
  users,
} from "../../src/server/db/schema";
import { runRetentionCleanup } from "../../src/server/services/retention";
import { generateUuidv7 } from "../../src/lib/uuidv7";

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_CLIENT_ID = "retention-test-client";

async function createTestUser(): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `retention-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return userId;
}

async function createSession(userId: string, expiresAt: Date, revokedAt?: Date): Promise<string> {
  const id = generateUuidv7();
  await db.insert(sessions).values({
    id,
    userId,
    tokenHash: `hash-${id}`,
    expiresAt,
    revokedAt: revokedAt ?? null,
    createdAt: new Date(),
    lastActiveAt: new Date(),
  });
  return id;
}

async function createAccessToken(
  userId: string,
  expiresAt: Date,
  options: { clientId?: string; revokedAt?: Date } = {}
): Promise<string> {
  const id = generateUuidv7();
  await db.insert(oauthAccessTokens).values({
    id,
    tokenHash: `hash-${id}`,
    clientId: options.clientId ?? TEST_CLIENT_ID,
    userId,
    scopes: ["mcp"],
    expiresAt,
    revokedAt: options.revokedAt ?? null,
    createdAt: new Date(),
  });
  return id;
}

async function createRefreshToken(
  userId: string,
  expiresAt: Date,
  options: {
    clientId?: string;
    revokedAt?: Date;
    accessTokenId?: string;
    replacedById?: string;
  } = {}
): Promise<string> {
  const id = generateUuidv7();
  await db.insert(oauthRefreshTokens).values({
    id,
    tokenHash: `hash-${id}`,
    clientId: options.clientId ?? TEST_CLIENT_ID,
    userId,
    scopes: ["mcp"],
    expiresAt,
    revokedAt: options.revokedAt ?? null,
    accessTokenId: options.accessTokenId ?? null,
    replacedById: options.replacedById ?? null,
    createdAt: new Date(),
  });
  return id;
}

async function createClient(clientId: string, createdAt: Date): Promise<string> {
  await db.insert(oauthClients).values({
    id: generateUuidv7(),
    clientId,
    name: "Test DCR Client",
    redirectUris: ["https://example.com/callback"],
    createdAt,
    updatedAt: createdAt,
  });
  return clientId;
}

async function createConsentGrant(
  userId: string,
  clientId: string,
  options: { revokedAt?: Date } = {}
): Promise<string> {
  const id = generateUuidv7();
  await db.insert(oauthConsentGrants).values({
    id,
    userId,
    clientId,
    scopes: ["mcp"],
    revokedAt: options.revokedAt ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function createAuthCode(userId: string, expiresAt: Date): Promise<string> {
  const id = generateUuidv7();
  await db.insert(oauthAuthorizationCodes).values({
    id,
    codeHash: `hash-${id}`,
    clientId: TEST_CLIENT_ID,
    userId,
    redirectUri: "https://example.com/callback",
    scopes: ["mcp"],
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    expiresAt,
    createdAt: new Date(),
  });
  return id;
}

async function createFeed(): Promise<string> {
  const id = generateUuidv7();
  await db.insert(feeds).values({
    id,
    type: "web",
    url: `https://retention-${id}.example.com/feed.xml`,
  });
  return id;
}

async function createSubscription(
  userId: string,
  feedId: string,
  options: { unsubscribedAt?: Date } = {}
): Promise<string> {
  const id = generateUuidv7();
  await db.insert(subscriptions).values({
    id,
    userId,
    feedId,
    unsubscribedAt: options.unsubscribedAt ?? null,
  });
  return id;
}

async function createFeedJob(
  feedId: string,
  options: { createdAt?: Date; runningSince?: Date } = {}
): Promise<string> {
  const id = generateUuidv7();
  const createdAt = options.createdAt ?? new Date(Date.now() - DAY_MS);
  await db.insert(jobs).values({
    id,
    type: "fetch_feed",
    payload: { feedId },
    nextRunAt: new Date(Date.now() - DAY_MS),
    runningSince: options.runningSince ?? null,
    createdAt,
    updatedAt: createdAt,
  });
  return id;
}

async function cleanupTables(): Promise<void> {
  await db.delete(oauthRefreshTokens);
  await db.delete(oauthAccessTokens);
  await db.delete(oauthAuthorizationCodes);
  await db.delete(oauthConsentGrants);
  await db.delete(oauthClients);
  await db.delete(sessions);
  await db.delete(jobs);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

async function createApiToken(
  userId: string,
  options: { expiresAt?: Date | null; revokedAt?: Date } = {}
): Promise<string> {
  const id = generateUuidv7();
  await db.insert(apiTokens).values({
    id,
    userId,
    tokenHash: `hash-${id}`,
    scopes: ["mcp"],
    expiresAt: options.expiresAt ?? null,
    revokedAt: options.revokedAt ?? null,
    createdAt: new Date(),
  });
  return id;
}

async function createOpmlImport(
  userId: string,
  options: { status: string; createdAt: Date }
): Promise<string> {
  const id = generateUuidv7();
  await db.insert(opmlImports).values({
    id,
    userId,
    status: options.status,
    totalFeeds: 1,
    feedsData: [],
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
  });
  return id;
}

describe("runRetentionCleanup", () => {
  beforeEach(cleanupTables);
  afterAll(cleanupTables);

  it("deletes expired sessions and keeps live ones", async () => {
    const userId = await createTestUser();
    const expired = await createSession(userId, new Date(Date.now() - 2 * DAY_MS));
    const live = await createSession(userId, new Date(Date.now() + DAY_MS));
    // Expired less than the 1-day grace period ago: kept.
    const justExpired = await createSession(userId, new Date(Date.now() - 60 * 1000));
    // Revoked long ago but not yet expired: deleted.
    const longRevoked = await createSession(
      userId,
      new Date(Date.now() + DAY_MS),
      new Date(Date.now() - 31 * DAY_MS)
    );

    const result = await runRetentionCleanup(db);

    expect(result.sessions).toBe(2);
    const remaining = (await db.select({ id: sessions.id }).from(sessions)).map((r) => r.id);
    expect(remaining.sort()).toEqual([live, justExpired].sort());
    expect(remaining).not.toContain(expired);
    expect(remaining).not.toContain(longRevoked);
  });

  it("deletes expired/long-revoked API tokens and keeps live/non-expiring ones", async () => {
    const userId = await createTestUser();
    const expired = await createApiToken(userId, { expiresAt: new Date(Date.now() - 2 * DAY_MS) });
    const live = await createApiToken(userId, { expiresAt: new Date(Date.now() + 30 * DAY_MS) });
    // Non-expiring token (expiresAt NULL): never swept until revoked.
    const nonExpiring = await createApiToken(userId, { expiresAt: null });
    // Just expired (inside grace period): kept.
    const justExpired = await createApiToken(userId, {
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    // Revoked long ago but not expired: deleted.
    const longRevoked = await createApiToken(userId, {
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
      revokedAt: new Date(Date.now() - 31 * DAY_MS),
    });

    const result = await runRetentionCleanup(db);

    expect(result.apiTokens).toBe(2);
    const remaining = (await db.select({ id: apiTokens.id }).from(apiTokens)).map((r) => r.id);
    expect(remaining.sort()).toEqual([live, nonExpiring, justExpired].sort());
    expect(remaining).not.toContain(expired);
    expect(remaining).not.toContain(longRevoked);
  });

  it("deletes old terminal OPML imports and keeps recent/in-progress ones", async () => {
    const userId = await createTestUser();
    const oldCompleted = await createOpmlImport(userId, {
      status: "completed",
      createdAt: new Date(Date.now() - 31 * DAY_MS),
    });
    const oldFailed = await createOpmlImport(userId, {
      status: "failed",
      createdAt: new Date(Date.now() - 31 * DAY_MS),
    });
    // Recent terminal import: kept for the user to review.
    const recentCompleted = await createOpmlImport(userId, {
      status: "completed",
      createdAt: new Date(Date.now() - DAY_MS),
    });
    // Old but still in-progress: never reaped.
    const oldProcessing = await createOpmlImport(userId, {
      status: "processing",
      createdAt: new Date(Date.now() - 31 * DAY_MS),
    });

    const result = await runRetentionCleanup(db);

    expect(result.opmlImports).toBe(2);
    const remaining = (await db.select({ id: opmlImports.id }).from(opmlImports)).map((r) => r.id);
    expect(remaining.sort()).toEqual([recentCompleted, oldProcessing].sort());
    expect(remaining).not.toContain(oldCompleted);
    expect(remaining).not.toContain(oldFailed);
  });

  it("deletes expired OAuth authorization codes, access tokens, and refresh tokens", async () => {
    const userId = await createTestUser();

    const expiredCode = await createAuthCode(userId, new Date(Date.now() - 2 * DAY_MS));
    const liveCode = await createAuthCode(userId, new Date(Date.now() + 10 * 60 * 1000));

    const expiredAccess = await createAccessToken(userId, new Date(Date.now() - 2 * DAY_MS));
    const liveAccess = await createAccessToken(userId, new Date(Date.now() + 60 * 60 * 1000));

    const expiredRefresh = await createRefreshToken(userId, new Date(Date.now() - 2 * DAY_MS));
    const liveRefresh = await createRefreshToken(userId, new Date(Date.now() + 30 * DAY_MS));

    const result = await runRetentionCleanup(db);

    expect(result.oauthAuthorizationCodes).toBe(1);
    expect(result.oauthAccessTokens).toBe(1);
    expect(result.oauthRefreshTokens).toBe(1);

    const codes = (
      await db.select({ id: oauthAuthorizationCodes.id }).from(oauthAuthorizationCodes)
    ).map((r) => r.id);
    expect(codes).toEqual([liveCode]);
    expect(codes).not.toContain(expiredCode);

    const access = (await db.select({ id: oauthAccessTokens.id }).from(oauthAccessTokens)).map(
      (r) => r.id
    );
    expect(access).toEqual([liveAccess]);
    expect(access).not.toContain(expiredAccess);

    const refresh = (await db.select({ id: oauthRefreshTokens.id }).from(oauthRefreshTokens)).map(
      (r) => r.id
    );
    expect(refresh).toEqual([liveRefresh]);
    expect(refresh).not.toContain(expiredRefresh);
  });

  it("handles refresh-token rotation chains (replaced_by_id) without FK failures", async () => {
    const userId = await createTestUser();

    // Rotation: old token revoked long ago points at its expired replacement.
    // Both are deletable; the replaced_by_id FK is ON DELETE SET NULL so the
    // deletion order can't matter.
    const newToken = await createRefreshToken(userId, new Date(Date.now() - 2 * DAY_MS), {
      revokedAt: new Date(Date.now() - 31 * DAY_MS),
    });
    await createRefreshToken(userId, new Date(Date.now() - 2 * DAY_MS), {
      revokedAt: new Date(Date.now() - 32 * DAY_MS),
      replacedById: newToken,
    });
    // A live token pointing at a deletable one must survive with the pointer nulled.
    const survivor = await createRefreshToken(userId, new Date(Date.now() + 30 * DAY_MS), {
      replacedById: newToken,
    });

    const result = await runRetentionCleanup(db);

    expect(result.oauthRefreshTokens).toBe(2);
    const remaining = await db
      .select({ id: oauthRefreshTokens.id, replacedById: oauthRefreshTokens.replacedById })
      .from(oauthRefreshTokens);
    expect(remaining).toEqual([{ id: survivor, replacedById: null }]);
  });

  it("deletes parked one-time OPML import jobs but not scheduled or running ones", async () => {
    const parkedId = generateUuidv7();
    const dueId = generateUuidv7();
    const runningId = generateUuidv7();
    const feedJobId = generateUuidv7();
    const now = new Date();

    await db.insert(jobs).values([
      // Completed one-time job, parked 365 days out.
      {
        id: parkedId,
        type: "process_opml_import",
        payload: { importId: generateUuidv7() },
        nextRunAt: new Date(now.getTime() + 365 * DAY_MS),
      },
      // Pending import: due now.
      {
        id: dueId,
        type: "process_opml_import",
        payload: { importId: generateUuidv7() },
        nextRunAt: now,
      },
      // Defensive: far-future next_run_at but currently running.
      {
        id: runningId,
        type: "process_opml_import",
        payload: { importId: generateUuidv7() },
        nextRunAt: new Date(now.getTime() + 365 * DAY_MS),
        runningSince: now,
      },
      // Recurring feed job parked far out (e.g. after a redirect merge): kept.
      {
        id: feedJobId,
        type: "fetch_feed",
        payload: { feedId: generateUuidv7() },
        nextRunAt: new Date(now.getTime() + 365 * DAY_MS),
      },
    ]);

    const result = await runRetentionCleanup(db);

    expect(result.parkedJobs).toBe(1);
    const remaining = (await db.select({ id: jobs.id }).from(jobs)).map((r) => r.id);
    expect(remaining.sort()).toEqual([dueId, runningId, feedJobId].sort());
    expect(remaining).not.toContain(parkedId);
  });

  it("deletes subscriber-less fetch_feed jobs but keeps subscribed, running, or fresh ones", async () => {
    const userId = await createTestUser();

    // Active subscriber: kept.
    const subscribedFeed = await createFeed();
    await createSubscription(userId, subscribedFeed);
    const subscribedJobId = await createFeedJob(subscribedFeed);

    // Only an unsubscribed (soft-deleted) subscription: dead, deleted.
    const unsubscribedFeed = await createFeed();
    await createSubscription(userId, unsubscribedFeed, { unsubscribedAt: new Date() });
    const unsubscribedJobId = await createFeedJob(unsubscribedFeed);

    // No subscription at all (e.g. deleteUser orphan cleanup): dead, deleted.
    const orphanFeed = await createFeed();
    const orphanJobId = await createFeedJob(orphanFeed);

    // No subscribers but currently running: kept (never touch an in-flight job).
    const runningFeed = await createFeed();
    const runningJobId = await createFeedJob(runningFeed, { runningSince: new Date() });

    // No subscribers, running_since set but stale (crashed mid-fetch): still
    // kept — the guard is intentionally stricter than claimFeedJob's staleness
    // check, deferring to a later sweep after the stale job is reclaimed.
    const staleRunningFeed = await createFeed();
    const staleRunningJobId = await createFeedJob(staleRunningFeed, {
      runningSince: new Date(Date.now() - 7 * DAY_MS),
    });

    // No subscribers but freshly created — races the first-ever subscribe, whose
    // job commits just before its subscription: kept by the created_at grace.
    const freshFeed = await createFeed();
    const freshJobId = await createFeedJob(freshFeed, { createdAt: new Date() });

    const result = await runRetentionCleanup(db);

    expect(result.deadFeedJobs).toBe(2);
    const remaining = (await db.select({ id: jobs.id }).from(jobs)).map((r) => r.id);
    expect(remaining.sort()).toEqual(
      [subscribedJobId, runningJobId, staleRunningJobId, freshJobId].sort()
    );
    expect(remaining).not.toContain(unsubscribedJobId);
    expect(remaining).not.toContain(orphanJobId);
  });

  it("deletes orphaned old DCR clients but keeps recent or actively-used ones", async () => {
    const userId = await createTestUser();
    const old = new Date(Date.now() - 40 * DAY_MS);
    const recentDate = new Date(Date.now() - 2 * DAY_MS);

    // Old registration that never completed authorization: deleted.
    const orphaned = await createClient("dcr-orphaned", old);

    // Recently registered, still mid-onboarding: kept despite no tokens.
    const recent = await createClient("dcr-recent", recentDate);

    // Old but has a live access token: kept.
    const withLiveAccess = await createClient("dcr-live-access", old);
    await createAccessToken(userId, new Date(Date.now() + 60 * 60 * 1000), {
      clientId: withLiveAccess,
    });

    // Old but has a live refresh token: kept.
    const withLiveRefresh = await createClient("dcr-live-refresh", old);
    await createRefreshToken(userId, new Date(Date.now() + 30 * DAY_MS), {
      clientId: withLiveRefresh,
    });

    // Old but has an active consent grant (tokens all expired): kept.
    const withConsent = await createClient("dcr-consent", old);
    await createConsentGrant(userId, withConsent);

    // Old with only dead tokens (expired access, revoked refresh) and a revoked
    // consent grant: nothing live, so deleted.
    const withDeadGrants = await createClient("dcr-dead", old);
    await createAccessToken(userId, new Date(Date.now() - 2 * DAY_MS), {
      clientId: withDeadGrants,
    });
    await createRefreshToken(userId, new Date(Date.now() + 30 * DAY_MS), {
      clientId: withDeadGrants,
      revokedAt: new Date(Date.now() - DAY_MS),
    });
    await createConsentGrant(userId, withDeadGrants, {
      revokedAt: new Date(Date.now() - DAY_MS),
    });

    const result = await runRetentionCleanup(db);

    expect(result.oauthClients).toBe(2);
    const remaining = (await db.select({ clientId: oauthClients.clientId }).from(oauthClients)).map(
      (r) => r.clientId
    );
    expect(remaining.sort()).toEqual([recent, withLiveAccess, withLiveRefresh, withConsent].sort());
    expect(remaining).not.toContain(orphaned);
    expect(remaining).not.toContain(withDeadGrants);
  });

  it("returns zero counts when there is nothing to delete", async () => {
    const result = await runRetentionCleanup(db);
    expect(result).toEqual({
      sessions: 0,
      apiTokens: 0,
      oauthAuthorizationCodes: 0,
      oauthAccessTokens: 0,
      oauthRefreshTokens: 0,
      oauthClients: 0,
      opmlImports: 0,
      parkedJobs: 0,
      deadFeedJobs: 0,
    });
  });
});
