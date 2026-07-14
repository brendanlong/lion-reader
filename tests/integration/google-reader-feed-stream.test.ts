/**
 * Integration tests for the Google Reader feed-stream resolvers — the reverse
 * lookups that turn a `feed/{int64}` stream id back into a subscription or the
 * user's saved-articles feed. Stream ids are stored serials
 * (`subscriptions.greader_stream_id` / `feeds.greader_stream_id`, issue #1117),
 * so resolution is a unique-index seek scoped to the user; these tests lock in
 * the round-trip, the user scoping, and the out-of-range/unknown-id guards.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, feeds, subscriptions } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import {
  feedStreamIdToSubscriptionUuid,
  resolveFeedStream,
} from "../../src/server/google-reader/id";

const createdUserIds: string[] = [];
const createdFeedIds: string[] = [];

afterAll(async () => {
  if (createdFeedIds.length > 0) {
    await db.delete(feeds).where(inArray(feeds.id, createdFeedIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

async function createUser(): Promise<string> {
  const id = generateUuidv7();
  await db.insert(users).values({
    id,
    email: `feed-stream-${id}@test.com`,
    passwordHash: "test-hash",
  });
  createdUserIds.push(id);
  return id;
}

async function createSubscription(userId: string): Promise<{ subId: string; streamId: bigint }> {
  const feedId = generateUuidv7();
  const subId = generateUuidv7();
  await db.insert(feeds).values({ id: feedId, type: "web", url: `https://f/${feedId}` });
  createdFeedIds.push(feedId);
  const [sub] = await db
    .insert(subscriptions)
    .values({ id: subId, userId, feedId })
    .returning({ greaderStreamId: subscriptions.greaderStreamId });
  return { subId, streamId: sub.greaderStreamId };
}

async function createSavedFeed(userId: string): Promise<{ feedId: string; streamId: bigint }> {
  const feedId = generateUuidv7();
  const [feed] = await db
    .insert(feeds)
    .values({ id: feedId, type: "saved", userId })
    .returning({ greaderStreamId: feeds.greaderStreamId });
  createdFeedIds.push(feedId);
  return { feedId, streamId: feed.greaderStreamId };
}

describe("feedStreamIdToSubscriptionUuid", () => {
  it("resolves a subscription's stream serial back to its UUID", async () => {
    const userId = await createUser();
    const { subId, streamId } = await createSubscription(userId);
    expect(await feedStreamIdToSubscriptionUuid(db, userId, streamId)).toBe(subId);
  });

  it("is user-scoped — another user's stream id does not resolve", async () => {
    const owner = await createUser();
    const other = await createUser();
    const { streamId } = await createSubscription(owner);
    expect(await feedStreamIdToSubscriptionUuid(db, other, streamId)).toBeNull();
  });

  it("returns null for an unknown stream id", async () => {
    const userId = await createUser();
    // A serial far beyond anything the sequence has handed out.
    const { streamId } = await createSubscription(userId);
    expect(
      await feedStreamIdToSubscriptionUuid(db, userId, streamId + BigInt(1_000_000_000))
    ).toBeNull();
  });

  it("returns null for an id outside the bigint range without throwing", async () => {
    const userId = await createUser();
    const beyondInt64 = BigInt(2) ** BigInt(64);
    expect(await feedStreamIdToSubscriptionUuid(db, userId, beyondInt64)).toBeNull();
  });
});

describe("resolveFeedStream", () => {
  it("resolves a subscription stream id to a subscription", async () => {
    const userId = await createUser();
    const { subId, streamId } = await createSubscription(userId);
    expect(await resolveFeedStream(db, userId, streamId)).toEqual({
      kind: "subscription",
      subscriptionId: subId,
    });
  });

  it("resolves the saved feed's stream id to the saved feed", async () => {
    const userId = await createUser();
    const { feedId, streamId } = await createSavedFeed(userId);
    expect(await resolveFeedStream(db, userId, streamId)).toEqual({
      kind: "saved",
      feedId,
    });
  });

  it("does not resolve another user's saved feed", async () => {
    const owner = await createUser();
    const other = await createUser();
    const { streamId } = await createSavedFeed(owner);
    expect(await resolveFeedStream(db, other, streamId)).toBeNull();
  });

  it("returns null for an id matching nothing the user owns", async () => {
    const userId = await createUser();
    const { streamId } = await createSubscription(userId);
    expect(await resolveFeedStream(db, userId, streamId + BigInt(1_000_000_000))).toBeNull();
  });
});

describe("greader stream id uniqueness across subscriptions and feeds", () => {
  it("draws subscription and saved-feed stream ids from one sequence (no collision)", async () => {
    // Both tables default from the shared greader_id_seq, so a saved feed can
    // never share a subscription's stream id — the invariant resolveFeedStream
    // relies on to try subscriptions first, then the saved feed, unambiguously.
    const userId = await createUser();
    const { streamId: subStream } = await createSubscription(userId);
    const { streamId: savedStream } = await createSavedFeed(userId);
    expect(subStream).not.toBe(savedStream);
  });

  it("keeps greader_stream_id unique across all subscriptions", async () => {
    const userId = await createUser();
    const a = await createSubscription(userId);
    const b = await createSubscription(userId);
    expect(a.streamId).not.toBe(b.streamId);

    const rows = await db
      .select({ streamId: subscriptions.greaderStreamId })
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId));
    const ids = rows.map((r) => r.streamId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
