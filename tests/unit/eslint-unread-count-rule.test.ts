/**
 * The lint rule that keeps unread counts on the counters (#1542): a `count(`
 * over visible_entries/user_entries in src/ fails `eslint` with a message
 * naming what to use instead. Lints planted code through the repo's real
 * config.
 */

import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

const eslint = new ESLint();

/** The rule's messages for `code`, linted as if it lived in src/server/services. */
async function violations(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: "src/server/services/planted.ts",
  });
  return result.messages
    .filter((message) => message.ruleId === "no-restricted-syntax")
    .map((message) => message.message);
}

const HEADER = `
import { count, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { subscriptions, userEntries, visibleEntries } from "@/server/db/schema";
`;

describe("no counting entry rows in src/", () => {
  it.each([
    [
      "a Drizzle count from visibleEntries",
      "db.select({ n: sql<number>`count(*)::int` }).from(visibleEntries);",
    ],
    ["count() from userEntries", "db.select({ n: count() }).from(userEntries);"],
    [
      "a count joining userEntries",
      "db.select({ n: sql`COUNT(*)` }).from(subscriptions).innerJoin(userEntries, sql`true`);",
    ],
    ["$count over visibleEntries", "db.$count(visibleEntries);"],
    [
      "raw SQL naming the view",
      "db.execute(sql`SELECT count(*) FROM visible_entries WHERE NOT read`);",
    ],
    [
      "raw SQL interpolating the table",
      "db.execute(sql`SELECT count(*) FROM ${userEntries} WHERE NOT read`);",
    ],
  ])("flags %s, saying what to use instead", async (_name, code) => {
    const messages = await violations(`${HEADER}\nexport const q = ${code}\n`);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("countEntries");
  });

  it.each([
    ["a counter read", "db.select({ n: subscriptions.unreadCount }).from(subscriptions);"],
    ["a count of another table", "db.select({ n: count() }).from(subscriptions);"],
    ["a counter column in raw SQL", "db.execute(sql`SELECT unread_count(1) FROM user_entries`);"],
  ])("allows %s", async (_name, code) => {
    expect(await violations(`${HEADER}\nexport const q = ${code}\n`)).toEqual([]);
  });
});
