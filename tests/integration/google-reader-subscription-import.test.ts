/**
 * Integration tests for the Google Reader `subscription/import` (OPML) endpoint.
 *
 * Newsflash (via the greader_api client) POSTs a raw OPML document to this path
 * and expects an `OK: {count}` response; we queue the same async import the
 * tRPC `subscriptions.import` mutation does (issue #1059). These tests exercise
 * the route handler directly with a reader-scoped session.
 */

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import * as argon2 from "argon2";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, opmlImports, jobs } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createSession } from "../../src/server/auth/session";
import { OAUTH_SCOPES } from "../../src/server/oauth/utils";
import { MAX_OPML_BYTES } from "../../src/server/services/imports";
import { POST } from "../../src/app/api/greader.php/reader/api/0/subscription/import/route";

const createdUserIds: string[] = [];
const PASSWORD = "correct-horse-battery-staple";

async function createConfirmedUser(): Promise<string> {
  const id = generateUuidv7();
  await db.insert(users).values({
    id,
    email: `greader-import-${id}@test.com`,
    passwordHash: await argon2.hash(PASSWORD),
    tosAgreedAt: new Date(),
    privacyPolicyAgreedAt: new Date(),
    notEuAgreedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  createdUserIds.push(id);
  return id;
}

async function readerToken(userId: string): Promise<string> {
  const { token } = await createSession(db, {
    userId,
    scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
  });
  return token;
}

function importRequest(body: string, token?: string): Request {
  return new Request("https://example.com/api/greader.php/reader/api/0/subscription/import", {
    method: "POST",
    headers: {
      ...(token ? { authorization: `GoogleLogin auth=${token}` } : {}),
      // The greader_api client labels the raw-OPML body as form-urlencoded.
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

function sampleOpml(urls: string[]): string {
  const outlines = urls
    .map(
      (url, i) =>
        `    <outline type="rss" text="Feed ${i + 1}" title="Feed ${i + 1}" xmlUrl="${url}" htmlUrl="https://site${i + 1}.example.com" />`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Test OPML</title></head>
  <body>
${outlines}
  </body>
</opml>`;
}

beforeEach(async () => {
  await db.delete(opmlImports);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(opmlImports).where(inArray(opmlImports.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("POST reader/api/0/subscription/import", () => {
  it("queues an import and returns OK with the feed count", async () => {
    const userId = await createConfirmedUser();
    const token = await readerToken(userId);

    const opml = sampleOpml(["https://a.example.com/feed.xml", "https://b.example.com/feed.xml"]);
    const res = await POST(importRequest(opml, token));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK: 2");

    // An import record was created for this user with the deduplicated count.
    const records = await db.select().from(opmlImports).where(eq(opmlImports.userId, userId));
    expect(records).toHaveLength(1);
    expect(records[0].totalFeeds).toBe(2);
    expect(records[0].status).toBe("pending");

    // A background job was queued to process it.
    const queued = await db.select().from(jobs).where(eq(jobs.type, "process_opml_import"));
    const forThisImport = queued.filter(
      (j) => (j.payload as { importId?: string }).importId === records[0].id
    );
    expect(forThisImport).toHaveLength(1);

    await db.delete(jobs).where(
      inArray(
        jobs.id,
        queued.map((j) => j.id)
      )
    );
  });

  it("deduplicates feeds listed multiple times", async () => {
    const userId = await createConfirmedUser();
    const token = await readerToken(userId);

    const opml = sampleOpml([
      "https://dup.example.com/feed.xml",
      "https://dup.example.com/feed.xml",
      "https://other.example.com/feed.xml",
    ]);
    const res = await POST(importRequest(opml, token));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK: 2");

    await db.delete(jobs).where(eq(jobs.type, "process_opml_import"));
  });

  it("returns OK: 0 for OPML with no feeds", async () => {
    const userId = await createConfirmedUser();
    const token = await readerToken(userId);

    const opml = `<?xml version="1.0"?><opml version="2.0"><head/><body></body></opml>`;
    const res = await POST(importRequest(opml, token));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK: 0");

    const [record] = await db.select().from(opmlImports).where(eq(opmlImports.userId, userId));
    expect(record.status).toBe("completed");
  });

  it("rejects an empty body with 400", async () => {
    const userId = await createConfirmedUser();
    const token = await readerToken(userId);

    const res = await POST(importRequest("", token));
    expect(res.status).toBe(400);
  });

  it("rejects malformed OPML with 400", async () => {
    const userId = await createConfirmedUser();
    const token = await readerToken(userId);

    const res = await POST(importRequest("this is not xml at all", token));
    expect(res.status).toBe(400);
  });

  it("rejects an oversized payload with 413", async () => {
    const userId = await createConfirmedUser();
    const token = await readerToken(userId);

    // Exceed the byte limit; the size guard runs before parsing, so the content
    // need not be valid OPML.
    const res = await POST(importRequest("x".repeat(MAX_OPML_BYTES + 1), token));
    expect(res.status).toBe(413);
  });

  it("returns 401 without a token", async () => {
    const opml = sampleOpml(["https://x.example.com/feed.xml"]);
    const res = await POST(importRequest(opml));
    expect(res.status).toBe(401);
  });

  it("returns 403 for a session scoped to something other than reader access", async () => {
    const userId = await createConfirmedUser();
    const { token } = await createSession(db, {
      userId,
      scopes: [OAUTH_SCOPES.SAVED_WRITE],
    });

    const opml = sampleOpml(["https://y.example.com/feed.xml"]);
    const res = await POST(importRequest(opml, token));
    expect(res.status).toBe(403);
  });
});
