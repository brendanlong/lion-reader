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
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { createTestEntry, createTestFeed, createTestSubscription, createTestUser } from "./helpers";
import { registerTools, toMcpError } from "../../src/server/mcp/tools";

let userId: string;
let otherUserId: string;
let entryId: string;
let pageServer: Server;
let pageUrl: string;
/** The Markdown served at `pageUrl`; tests change it to simulate a revised page. */
let pageBody = "";

function tool(name: string) {
  const found = registerTools().find((t) => t.name === name);
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
    // Tag colors are rendered into inline styles; the MCP surface must
    // enforce the same hex-format invariant as the tRPC tags router.
    await expect(
      tool("create_tag").handler(db, userId, {
        name: "Bad color",
        color: "red;background-image:url(https://attacker.example/x)",
      })
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

  it("returns JSON-serializable results with no greaderItemId leak", async () => {
    // Both MCP transports serialize tool results with plain JSON.stringify,
    // which throws on bigint. Entries carry the Google Reader-internal
    // greaderItemId (a bigint); list_entries/get_entry must strip it — this
    // mirrors what the tRPC/REST output schemas do on those surfaces.
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
