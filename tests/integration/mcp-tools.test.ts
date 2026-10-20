/**
 * Integration tests for MCP tool argument validation and result shapes.
 *
 * Tool handlers validate client-supplied arguments with Zod before calling
 * the services layer (issue #956): unknown keys (internal service params,
 * userId) are stripped, malformed values are rejected with InvalidParams,
 * and the advertised inputSchema is generated from the same Zod schema.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { db } from "../../src/server/db";
import { eq } from "drizzle-orm";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import {
  createTestEmailSubscription,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestUser,
} from "./helpers";
import { getTools, toMcpError } from "../../src/server/mcp/tools";
import { createApiToken } from "../../src/server/auth/api-token";
import { GET as restHandler } from "../../src/app/api/v1/[...path]/route";

let userId: string;
let otherUserId: string;
let entryId: string;
let pageServer: Server;
let pageUrl: string;
/** The Markdown served at `pageUrl`; tests change it to simulate a revised page. */
let pageBody = "";

function tool(name: string) {
  const found = getTools().find((t) => t.name === name);
  if (!found) throw new Error(`Tool not registered: ${name}`);
  return found;
}

beforeAll(async () => {
  const now = new Date();

  userId = await createTestUser({ emailPrefix: "mcp-tools" });
  otherUserId = await createTestUser({ emailPrefix: "mcp-tools" });
  const feedId = await createTestFeed({
    title: "MCP Tools Test Feed",
    lastFetchedAt: now,
    lastEntriesUpdatedAt: now,
  });
  await createTestSubscription(userId, feedId);
  entryId = await createTestEntry(feedId, { title: "MCP visible entry", userIds: [userId] });

  // Loopback page for save_article (`.env.test` sets ALLOW_PRIVATE_NETWORK_FETCH).
  pageServer = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    res.end(pageBody);
  });
  await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
  pageUrl = `http://127.0.0.1:${(pageServer.address() as AddressInfo).port}/report.md`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => pageServer.close(() => resolve()));
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
});

describe("MCP tool argument validation", () => {
  it("advertises an inputSchema generated from the Zod schema", () => {
    for (const t of getTools()) {
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
    // Tag colors are rendered into inline styles; the MCP surface must
    // enforce the same hex-format invariant as the tRPC tags router.
    await expect(
      tool("create_tag").handler(db, userId, {
        name: "Bad color",
        color: "red;background-image:url(https://attacker.example/x)",
      })
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  // The REST handler turns on coercion in the input schemas it parses, which
  // the tools share with the tRPC procedures.
  it.each([
    [
      "list_entries",
      "/entries",
      ["uncategorized=false", "unreadOnly=false", "starredOnly=false", "limit=5"],
    ],
    ["count_entries", "/entries/count", ["uncategorized=false", "starredOnly=false"]],
    [
      "list_subscriptions",
      "/subscriptions",
      ["uncategorized=false", "unreadOnly=false", "limit=5"],
    ],
  ])("rejects a string arg in %s even after a REST call", async (name, path, params) => {
    const { token } = await createApiToken(userId, ["mcp"]);
    for (const param of params) {
      const res = await restHandler(
        new Request(`http://localhost:3000/api/v1${path}?${param}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      );
      expect(res.status).toBe(200);
      const [key, value] = param.split("=");
      await expect(tool(name).handler(db, userId, { [key]: value })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
      });
    }
  });

  it("strips unknown keys so internal service params can't be injected", async () => {
    // maxLimit is a Google-Reader-internal override of the 100-row cap; a
    // client-supplied value must be dropped rather than forwarded.
    const result = (await tool("list_entries").handler(db, userId, {
      maxLimit: 1000000,
    })) as { items: unknown[] };
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("returns JSON-serializable results with no greaderItemId leak", async () => {
    // Both MCP transports serialize tool results with plain JSON.stringify,
    // which throws on bigint, so the Google Reader serials must stay out of
    // the service entry types.
    const list = (await tool("list_entries").handler(db, userId, {})) as {
      items: Array<Record<string, unknown>>;
    };
    expect(list.items.length).toBeGreaterThan(0);
    for (const item of list.items) {
      expect(item).not.toHaveProperty("greaderItemId");
    }
    expect(() => JSON.stringify(list)).not.toThrow();

    const entry = (await tool("get_entry").handler(db, userId, { entryId })) as Record<
      string,
      unknown
    >;
    expect(entry).not.toHaveProperty("greaderItemId");
    expect(() => JSON.stringify(entry)).not.toThrow();
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

describe("MCP tool results", () => {
  it("orders a collection by set_collection_positions' entryIds, and lists by score", async () => {
    const feedId = await createTestFeed();
    await createTestSubscription(userId, feedId);
    const older = await createTestEntry(feedId, {
      userIds: [userId],
      fetchedAt: new Date("2025-01-01T00:00:00Z"),
    });
    const newer = await createTestEntry(feedId, {
      userIds: [userId],
      fetchedAt: new Date("2025-01-02T00:00:00Z"),
    });
    const { id: collectionId } = (await tool("create_collection").handler(db, userId, {
      name: "MCP book",
    })) as { id: string };
    await tool("add_to_collection").handler(db, userId, {
      collectionId,
      entryIds: [older, newer],
    });
    const listIds = async (args: Record<string, unknown>) =>
      (
        (await tool("list_entries").handler(db, userId, args)) as { items: { id: string }[] }
      ).items.map((item) => item.id);

    await tool("set_collection_positions").handler(db, userId, {
      collectionId,
      entryIds: [older, newer],
    });
    expect(await listIds({ subscriptionId: collectionId, sortBy: "position" })).toEqual([
      older,
      newer,
    ]);

    await tool("set_entry_scores").handler(db, userId, {
      scores: [
        { entryId: older, score: 2 },
        { entryId: newer, score: 1 },
      ],
    });
    expect(await listIds({ subscriptionId: collectionId, sortBy: "score" })).toEqual([
      older,
      newer,
    ]);
    expect(
      await listIds({ subscriptionId: collectionId, sortBy: "score", sortOrder: "lowest" })
    ).toEqual([newer, older]);

    for (const args of [
      { collectionId },
      { collectionId, entryIds: [older], positions: [{ entryId: older, position: 1 }] },
    ]) {
      await expect(
        tool("set_collection_positions").handler(db, userId, args)
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    }
  });

  it("returns save results without the article body (#1835)", async () => {
    const result = (await tool("upload_article").handler(db, userId, {
      title: "MCP upload",
      content: "# Heading\n\nThe body of the uploaded article.",
      summary: "Short summary",
    })) as Record<string, unknown>;
    expect(result).not.toHaveProperty("contentCleaned");
    expect(result).toMatchObject({ title: "MCP upload", excerpt: "Short summary" });
    expect(result.id).toEqual(expect.any(String));
  });

  it("returns the first upload_article result for a retry with the same key (#2070)", async () => {
    const args = { title: "Retried upload", content: "Body.", idempotencyKey: "agent-retry-1" };
    const first = (await tool("upload_article").handler(db, userId, args)) as { id: string };
    const retry = (await tool("upload_article").handler(db, userId, args)) as { id: string };

    expect(retry.id).toBe(first.id);
  });

  it("refetches an already-saved URL only when asked, honoring force (#1836)", async () => {
    const paragraph = "A paragraph of the report, long enough to count as real article text. ";
    const content = async (id: string) =>
      ((await tool("get_entry").handler(db, userId, { entryId: id })) as { contentCleaned: string })
        .contentCleaned;

    pageBody = `# Report\n\nFirst draft. ${paragraph.repeat(20)}`;
    const original = (await tool("save_article").handler(db, userId, { url: pageUrl })) as {
      id: string;
    };

    pageBody = "# Report\n\nRevised.";
    await tool("save_article").handler(db, userId, { url: pageUrl });
    expect(await content(original.id)).toContain("First draft.");

    // The guard's hint must reach MCP callers, who can't see the error's cause.
    const rejected = await tool("save_article")
      .handler(db, userId, { url: pageUrl, refetch: true })
      .then(() => undefined, toMcpError);
    expect(rejected).toBeInstanceOf(McpError);
    expect(rejected).toMatchObject({ data: { code: "REFETCH_CONTENT_WORSE" } });
    expect((rejected as McpError).message).toContain("force=true");

    const forced = (await tool("save_article").handler(db, userId, {
      url: pageUrl,
      refetch: true,
      force: true,
    })) as { id: string };
    expect(forced.id).toBe(original.id);
    expect(await content(original.id)).toContain("Revised.");
  });
});

describe("MCP list_entries spam", () => {
  it("follows the user's showSpam preference, like the other surfaces", async () => {
    const spamUserId = await createTestUser({ emailPrefix: "mcp-tools" });
    const subscriptionId = await createTestEmailSubscription(spamUserId);
    await createTestEntry(subscriptionId, {
      type: "email",
      title: "Spam mail",
      isSpam: true,
      userIds: [spamUserId],
    });
    const listTitles = async () =>
      (
        (await tool("list_entries").handler(db, spamUserId, {})) as { items: { title: string }[] }
      ).items.map((item) => item.title);

    expect(await listTitles()).not.toContain("Spam mail");
    await db.update(users).set({ showSpam: true }).where(eq(users.id, spamUserId));
    expect(await listTitles()).toContain("Spam mail");
  });
});
