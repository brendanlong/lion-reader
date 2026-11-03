import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { pgTable, integer } from "drizzle-orm/pg-core";
import { db } from "../../src/server/db";
import { estimateRows } from "../../src/server/db/estimate-rows";

const neverAnalyzed = pgTable("estimate_rows_never_analyzed", { n: integer() });

describe("estimateRows", () => {
  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS estimate_rows_never_analyzed`);
  });

  it("is null, not -1 or 0, before the table is first analyzed", async () => {
    await db.execute(sql`CREATE TABLE estimate_rows_never_analyzed (n integer)`);

    expect(await estimateRows(db, neverAnalyzed)).toBeNull();
  });
});
