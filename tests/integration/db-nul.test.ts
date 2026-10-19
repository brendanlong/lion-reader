/**
 * Integration tests for NUL replacement in stored values (NulSafeClient, nulSafeJsonb).
 */

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, opmlImports } from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { createAuthContext, createTestUser } from "./helpers";

describe("NUL in stored values", () => {
  // Sentry LION-READER-WEB-1G: X's pages carry raw NULs in an inline script.
  it("saves an article whose HTML contains NUL", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));

    const result = await caller.saved.save({
      url: "https://example.com/nul",
      html: '<html><head><title>NUL</title><script>$R={i:"__root__\u0000{}"}</script></head><body><p>Body</p></body></html>',
      refetch: false,
    });

    const [row] = await db
      .select({ contentOriginal: entries.contentOriginal })
      .from(entries)
      .where(eq(entries.id, result.article.id));
    expect(row.contentOriginal).toContain('"__root__\uFFFD{}"');
  });

  it("stores jsonb whose strings contain NUL", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));

    const { importId } = await caller.subscriptions.import({
      opml: `<?xml version="1.0"?><opml version="2.0"><body>
        <outline type="rss" text="a\u0000b" xmlUrl="https://example.com/nul.xml"/>
      </body></opml>`,
    });

    const [row] = await db
      .select({ feedsData: opmlImports.feedsData })
      .from(opmlImports)
      .where(eq(opmlImports.id, importId));
    expect(row.feedsData[0].title).toBe("a\uFFFDb");
  });
});
