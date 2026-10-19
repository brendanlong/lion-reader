/**
 * Integration tests for NUL replacement in query parameters (NulSafeClient).
 */

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries } from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { createAuthContext, createTestUser } from "./helpers";

describe("NUL in query parameters", () => {
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
});
