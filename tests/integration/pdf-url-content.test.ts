/**
 * URLs that serve a PDF: saving one (the browser extension, Android link
 * shares, MCP and Wallabag all save by URL) and fetching full content for a
 * feed entry that links to one. Real HTTP against a loopback server, so the
 * content-type detection is covered (`.env.test` sets
 * ALLOW_PRIVATE_NETWORK_FETCH).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, users } from "../../src/server/db/schema";
import { usageLimitsConfig } from "../../src/server/config/env";
import { getAppErrorCode } from "../../src/server/errors";
import { fetchFullContent } from "../../src/server/services/full-content";
import { saveArticle } from "../../src/server/services/saved";
import { buildPdf, textPage } from "../utils/pdf";
import { createTestUser } from "./helpers";

const BODY = textPage([
  "This is the opening paragraph of a PDF served from a URL. It has enough prose",
  "to be treated as a real article body rather than boilerplate.",
]);

const ROUTES: Record<string, { type: string; body: Buffer }> = {
  "/papers/report.pdf": {
    type: "application/pdf",
    body: buildPdf([BODY], { info: { Title: "A Served Report", Author: "Ada Lovelace" } }),
  },
  "/download/My_Weekly-Report.pdf": {
    type: "application/octet-stream",
    body: buildPdf([BODY]),
  },
  "/download/archive.bin": {
    type: "application/octet-stream",
    body: Buffer.from("not a pdf at all"),
  },
  // Past the saved-article size limit, so only a check of its first bytes can
  // tell it apart from an oversized PDF.
  "/download/big.bin": {
    type: "application/octet-stream",
    body: Buffer.alloc(usageLimitsConfig.maxSavedArticleSizeBytes + 1024, "x"),
  },
  "/papers/legacy.pdf": {
    type: "application/x-pdf",
    body: buildPdf([BODY], { info: { Title: "A Legacy Type" } }),
  },
  "/papers/scan.pdf": { type: "application/pdf", body: buildPdf([Buffer.from("")]) },
};

let server: Server;
let baseUrl: string;
const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "pdf-url" });
  createdUserIds.push(userId);
  return userId;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = ROUTES[req.url ?? "/"];
    if (route) {
      res.writeHead(200, { "Content-Type": route.type });
      res.end(route.body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("saveArticle on a PDF URL", () => {
  it("converts the PDF and uses its metadata", async () => {
    const userId = await createUser();
    const article = await saveArticle(db, userId, { url: `${baseUrl}/papers/report.pdf` });

    expect(article.title).toBe("A Served Report");
    expect(article.author).toBe("Ada Lovelace");
    const [stored] = await db
      .select({ contentCleaned: entries.contentCleaned })
      .from(entries)
      .where(eq(entries.id, article.id))
      .limit(1);
    expect(stored.contentCleaned).toContain("opening paragraph of a PDF served from a URL");
  });

  it("recognizes a PDF served as octet-stream and titles it from the URL", async () => {
    const userId = await createUser();
    const article = await saveArticle(db, userId, {
      url: `${baseUrl}/download/My_Weekly-Report.pdf`,
    });

    expect(article.title).toBe("My Weekly Report");
  });

  it("accepts the legacy application/x-pdf type", async () => {
    const userId = await createUser();
    const article = await saveArticle(db, userId, { url: `${baseUrl}/papers/legacy.pdf` });

    expect(article.title).toBe("A Legacy Type");
  });

  it.each(["/download/archive.bin", "/download/big.bin"])(
    "rejects another octet-stream download (%s) by its type, not its size",
    async (path) => {
      const userId = await createUser();
      const error = await saveArticle(db, userId, { url: `${baseUrl}${path}` }).catch(
        (e: unknown) => e
      );

      expect(getAppErrorCode(error)).toBe("SAVED_ARTICLE_FETCH_ERROR");
      expect((error as Error).message).toMatch(/Invalid content type/);
    }
  );

  it("tells the user when the PDF has no text", async () => {
    const userId = await createUser();
    const error = await saveArticle(db, userId, { url: `${baseUrl}/papers/scan.pdf` }).catch(
      (e: unknown) => e
    );

    expect(getAppErrorCode(error)).toBe("VALIDATION_ERROR");
    expect((error as Error).message).toMatch(/no text to extract/);
  });
});

describe("fetchFullContent on a PDF URL", () => {
  it("converts the PDF", async () => {
    const result = await fetchFullContent(`${baseUrl}/papers/report.pdf`, {
      offloadClean: false,
    });

    expect(result.success).toBe(true);
    expect(result.contentCleaned).toContain("opening paragraph of a PDF served from a URL");
  });
});
