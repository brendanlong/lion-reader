/**
 * Consistency checks between the migrations directory and meta/_journal.json.
 *
 * The migration runner only executes migrations listed in the journal, so a
 * .sql file that never gets journaled is silently skipped — databases built
 * from the journal (CI, tests, DR restores, new environments) end up missing
 * it even though it was applied manually to production (issue #953). These
 * tests fail CI when the journal and the directory drift apart.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { parseJournal, type Journal } from "../../scripts/run-migrations";

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

function loadJournal(): Journal {
  const content = fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf-8");
  return parseJournal(content);
}

function migrationFilesOnDisk(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f !== "schema.sql")
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
}

describe("migrations journal", () => {
  it("journals every migration .sql file on disk", () => {
    const journaled = new Set(loadJournal().entries.map((e) => e.tag));
    const unjournaled = migrationFilesOnDisk().filter((tag) => !journaled.has(tag));
    expect(unjournaled).toEqual([]);
  });

  it("has a .sql file on disk for every journal entry", () => {
    const onDisk = new Set(migrationFilesOnDisk());
    const missing = loadJournal()
      .entries.map((e) => e.tag)
      .filter((tag) => !onDisk.has(tag));
    expect(missing).toEqual([]);
  });

  it("has unique tags and sequential idx values", () => {
    const entries = loadJournal().entries;
    const tags = entries.map((e) => e.tag);
    expect(new Set(tags).size).toBe(tags.length);
    entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
    });
  });

  it("does not use CREATE INDEX CONCURRENTLY (the runner wraps each migration in a transaction)", () => {
    const offenders = migrationFilesOnDisk().filter((tag) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), "utf-8");
      const withoutComments = sql.replace(/--[^\n]*/g, "");
      return /\bCONCURRENTLY\b/i.test(withoutComments);
    });
    expect(offenders).toEqual([]);
  });
});
