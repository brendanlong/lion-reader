/**
 * Integration tests for MCP tool argument validation.
 *
 * Tool handlers validate client-supplied arguments with Zod before calling
 * the services layer (issue #956): unknown keys (internal service params,
 * userId) are stripped, malformed values are rejected with InvalidParams,
 * and the advertised inputSchema is generated from the same Zod schema.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  entries,
  subscriptions,
  subscriptionFeeds,
  userEntries,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { registerTools } from "../../src/server/mcp/tools";

let userId: string;
let otherUserId: string;
let entryId: string;

function tool(name: string) {
  const found = registerTools().find((t) => t.name === name);
  if (!found) throw new Error(`Tool not registered: ${name}`);
  return found;
}

beforeAll(async () => {
  userId = generateUuidv7();
  otherUserId = generateUuidv7();
  const feedId = generateUuidv7();
  const subscriptionId = generateUuidv7();
  entryId = generateUuidv7();
  const now = new Date();

  for (const id of [userId, otherUserId]) {
    await db.insert(users).values({
      id,
      email: `mcp-tools-${id}@test.com`,
      passwordHash: "test-hash",
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.insert(feeds).values({
    id: feedId,
    type: "web",
    url: `https://example.com/${feedId}.xml`,
    title: "MCP Tools Test Feed",
    lastFetchedAt: now,
    lastEntriesUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    feedId,
    subscribedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(subscriptionFeeds).values({ subscriptionId, feedId, userId });
  await db.insert(entries).values({
    id: entryId,
    feedId,
    type: "web",
    guid: `guid-${entryId}`,
    title: "MCP visible entry",
    contentHash: `hash-${entryId}`,
    fetchedAt: now,
    publishedAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(userEntries).values({ userId, entryId, read: false, starred: false });
});

afterAll(async () => {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
});

describe("MCP tool argument validation", () => {
  it("advertises an inputSchema generated from the Zod schema", () => {
    for (const t of registerTools()) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.properties).toBeDefined();
    }
    const listSchema = tool("list_entries").inputSchema;
    expect(Object.keys(listSchema.properties)).toContain("limit");
    // Internal service params must not be advertised
    expect(Object.keys(listSchema.properties)).not.toContain("maxLimit");
    expect(Object.keys(listSchema.properties)).not.toContain("userId");
  });

  it("rejects malformed arguments with InvalidParams", async () => {
    await expect(tool("get_entry").handler(db, userId, { entryId: "not-a-uuid" })).rejects.toThrow(
      McpError
    );
    await expect(
      tool("get_entry").handler(db, userId, { entryId: "not-a-uuid" })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(tool("get_entry").handler(db, userId, {})).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
    await expect(
      tool("mark_entries_read").handler(db, userId, { entryIds: [], read: true })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(
      tool("list_entries").handler(db, userId, { limit: 1000000 })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it("strips unknown keys so internal service params can't be injected", async () => {
    // maxLimit is a Google-Reader-internal override of the 100-row cap; a
    // client-supplied value must be dropped rather than forwarded.
    const result = (await tool("list_entries").handler(db, userId, {
      maxLimit: 1000000,
    })) as { items: unknown[] };
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("uses the authenticated userId, ignoring any userId in args", async () => {
    // The entry is visible to `userId` only. Passing userId in args (the old
    // injection channel) must not switch the acting user.
    const spoofed = (await tool("list_entries").handler(db, otherUserId, {
      userId,
    })) as { items: Array<{ id: string }> };
    expect(spoofed.items).toHaveLength(0);

    const legit = (await tool("list_entries").handler(db, userId, {})) as {
      items: Array<{ id: string }>;
    };
    expect(legit.items.map((e) => e.id)).toContain(entryId);
  });
});
