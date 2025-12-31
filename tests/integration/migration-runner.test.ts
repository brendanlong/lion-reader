/**
 * Integration tests for the custom migration runner.
 *
 * These tests create a temporary database and migration files to verify:
 * - Migrations are applied correctly
 * - Each migration runs in its own transaction (per-transaction rollback)
 * - Hash verification detects modified migration files
 * - Already-applied migrations are skipped
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  computeHash,
  parseJournal,
  runMigrations,
  splitStatements,
} from "../../scripts/run-migrations";

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_DB_NAME = "migration_runner_test";

/**
 * Parse DATABASE_URL to derive admin and test database URLs.
 * The admin URL connects to 'postgres' database for creating/dropping test databases.
 */
function getDatabaseUrls(): { adminUrl: string; testUrl: string } {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required for integration tests");
  }

  const url = new URL(databaseUrl);
  const baseUrl = `${url.protocol}//${url.username}:${url.password}@${url.host}`;

  return {
    adminUrl: `${baseUrl}/postgres`,
    testUrl: `${baseUrl}/${TEST_DB_NAME}`,
  };
}

const { adminUrl: ADMIN_DB_URL, testUrl: TEST_DB_URL } = getDatabaseUrls();

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestMigrationsDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-test-"));
  fs.mkdirSync(path.join(tmpDir, "meta"));
  return tmpDir;
}

function writeJournal(migrationsDir: string, entries: Array<{ tag: string; when: number }>): void {
  const journal = {
    version: "7",
    dialect: "postgresql",
    entries: entries.map((e, idx) => ({
      idx,
      version: "7",
      when: e.when,
      tag: e.tag,
      breakpoints: true,
    })),
  };
  fs.writeFileSync(
    path.join(migrationsDir, "meta", "_journal.json"),
    JSON.stringify(journal, null, 2)
  );
}

function writeMigration(migrationsDir: string, tag: string, sql: string): void {
  fs.writeFileSync(path.join(migrationsDir, `${tag}.sql`), sql);
}

function cleanupMigrationsDir(migrationsDir: string): void {
  fs.rmSync(migrationsDir, { recursive: true, force: true });
}

// ============================================================================
// Unit Tests for Pure Functions
// ============================================================================

describe("migration runner pure functions", () => {
  describe("computeHash", () => {
    it("computes SHA-256 hash of SQL content", () => {
      const sql = "CREATE TABLE test (id int);";
      const hash = computeHash(sql);

      // SHA-256 produces 64 hex characters
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    it("produces same hash for same content", () => {
      const sql = "CREATE TABLE test (id int);";
      expect(computeHash(sql)).toBe(computeHash(sql));
    });

    it("produces different hash for different content", () => {
      const sql1 = "CREATE TABLE test1 (id int);";
      const sql2 = "CREATE TABLE test2 (id int);";
      expect(computeHash(sql1)).not.toBe(computeHash(sql2));
    });
  });

  describe("splitStatements", () => {
    it("splits on statement-breakpoint marker", () => {
      const sql = `
CREATE TABLE a (id int);
--> statement-breakpoint
CREATE TABLE b (id int);
--> statement-breakpoint
CREATE INDEX idx ON a (id);
      `.trim();

      const statements = splitStatements(sql);
      expect(statements).toHaveLength(3);
      expect(statements[0]).toBe("CREATE TABLE a (id int);");
      expect(statements[1]).toBe("CREATE TABLE b (id int);");
      expect(statements[2]).toBe("CREATE INDEX idx ON a (id);");
    });

    it("handles single statement without breakpoints", () => {
      const sql = "CREATE TABLE test (id int);";
      const statements = splitStatements(sql);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toBe(sql);
    });

    it("filters out empty statements", () => {
      const sql = `
CREATE TABLE a (id int);
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE b (id int);
      `.trim();

      const statements = splitStatements(sql);
      expect(statements).toHaveLength(2);
    });
  });

  describe("parseJournal", () => {
    it("parses valid journal JSON", () => {
      const content = JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 0, version: "7", when: 1234567890, tag: "0000_test", breakpoints: true }],
      });

      const journal = parseJournal(content);
      expect(journal.version).toBe("7");
      expect(journal.dialect).toBe("postgresql");
      expect(journal.entries).toHaveLength(1);
      expect(journal.entries[0].tag).toBe("0000_test");
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("migration runner integration", () => {
  let adminPool: Pool;
  let migrationsDir: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: ADMIN_DB_URL });

    // Create test database
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await adminPool.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  });

  afterAll(async () => {
    // Drop test database
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await adminPool.end();
  });

  beforeEach(async () => {
    // Create fresh migrations directory for each test
    migrationsDir = createTestMigrationsDir();

    // Reset the test database schema
    const testPool = new Pool({ connectionString: TEST_DB_URL });
    try {
      await testPool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
      await testPool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await testPool.query("CREATE SCHEMA public");
    } finally {
      await testPool.end();
    }
  });

  afterAll(() => {
    if (migrationsDir) {
      cleanupMigrationsDir(migrationsDir);
    }
  });

  it("applies migrations to empty database", async () => {
    writeJournal(migrationsDir, [
      { tag: "0001_create_users", when: 1000000000000 },
      { tag: "0002_create_posts", when: 1000000001000 },
    ]);

    writeMigration(
      migrationsDir,
      "0001_create_users",
      "CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL);"
    );
    writeMigration(
      migrationsDir,
      "0002_create_posts",
      "CREATE TABLE posts (id serial PRIMARY KEY, user_id int REFERENCES users(id));"
    );

    const result = await runMigrations(TEST_DB_URL, {
      migrationsDir,
      verbose: false,
    });

    expect(result.applied).toEqual(["0001_create_users", "0002_create_posts"]);
    expect(result.skipped).toEqual([]);

    // Verify tables exist
    const testPool = new Pool({ connectionString: TEST_DB_URL });
    try {
      const tables = await testPool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      expect(tables.rows.map((r) => r.table_name)).toEqual(["posts", "users"]);
    } finally {
      await testPool.end();
    }
  });

  it("skips already-applied migrations", async () => {
    writeJournal(migrationsDir, [
      { tag: "0001_create_users", when: 1000000000000 },
      { tag: "0002_create_posts", when: 1000000001000 },
    ]);

    writeMigration(
      migrationsDir,
      "0001_create_users",
      "CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL);"
    );
    writeMigration(
      migrationsDir,
      "0002_create_posts",
      "CREATE TABLE posts (id serial PRIMARY KEY, user_id int REFERENCES users(id));"
    );

    // Run migrations first time
    await runMigrations(TEST_DB_URL, { migrationsDir, verbose: false });

    // Run migrations second time
    const result = await runMigrations(TEST_DB_URL, {
      migrationsDir,
      verbose: false,
    });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["0001_create_users", "0002_create_posts"]);
  });

  it("applies only new migrations when some already exist", async () => {
    // First, apply initial migration
    writeJournal(migrationsDir, [{ tag: "0001_create_users", when: 1000000000000 }]);
    writeMigration(
      migrationsDir,
      "0001_create_users",
      "CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL);"
    );
    await runMigrations(TEST_DB_URL, { migrationsDir, verbose: false });

    // Add new migration to journal
    writeJournal(migrationsDir, [
      { tag: "0001_create_users", when: 1000000000000 },
      { tag: "0002_create_posts", when: 1000000001000 },
    ]);
    writeMigration(
      migrationsDir,
      "0002_create_posts",
      "CREATE TABLE posts (id serial PRIMARY KEY, user_id int REFERENCES users(id));"
    );

    // Run migrations again
    const result = await runMigrations(TEST_DB_URL, {
      migrationsDir,
      verbose: false,
    });

    expect(result.applied).toEqual(["0002_create_posts"]);
    expect(result.skipped).toEqual(["0001_create_users"]);
  });

  it("rolls back failed migration but preserves successful ones", async () => {
    writeJournal(migrationsDir, [
      { tag: "0001_create_users", when: 1000000000000 },
      { tag: "0002_will_fail", when: 1000000001000 },
    ]);

    writeMigration(
      migrationsDir,
      "0001_create_users",
      "CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL);"
    );
    writeMigration(
      migrationsDir,
      "0002_will_fail",
      `
ALTER TABLE users ADD COLUMN email text;
--> statement-breakpoint
ALTER TABLE nonexistent_table ADD COLUMN foo text;
      `.trim()
    );

    // Run migrations - should fail on second migration
    await expect(runMigrations(TEST_DB_URL, { migrationsDir, verbose: false })).rejects.toThrow();

    // Verify first migration was committed (users table exists)
    const testPool = new Pool({ connectionString: TEST_DB_URL });
    try {
      const tables = await testPool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `);
      expect(tables.rows.map((r) => r.table_name)).toContain("users");

      // Verify second migration was rolled back (email column doesn't exist)
      const columns = await testPool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users'
      `);
      expect(columns.rows.map((r) => r.column_name)).not.toContain("email");

      // Verify migrations table only has first migration
      const migrations = await testPool.query(`
        SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id
      `);
      expect(migrations.rows).toHaveLength(1);
    } finally {
      await testPool.end();
    }
  });

  it("detects hash mismatch for modified migration file", async () => {
    writeJournal(migrationsDir, [{ tag: "0001_create_users", when: 1000000000000 }]);
    writeMigration(
      migrationsDir,
      "0001_create_users",
      "CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL);"
    );

    // Apply migration
    await runMigrations(TEST_DB_URL, { migrationsDir, verbose: false });

    // Modify the migration file
    writeMigration(
      migrationsDir,
      "0001_create_users",
      "CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL, email text);"
    );

    // Running again should fail with hash mismatch
    await expect(runMigrations(TEST_DB_URL, { migrationsDir, verbose: false })).rejects.toThrow(
      /Hash mismatch/
    );
  });

  it("handles empty migrations directory", async () => {
    writeJournal(migrationsDir, []);

    const result = await runMigrations(TEST_DB_URL, {
      migrationsDir,
      verbose: false,
    });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("records correct created_at timestamp from journal", async () => {
    const timestamp = 1234567890123;
    writeJournal(migrationsDir, [{ tag: "0001_test", when: timestamp }]);
    writeMigration(migrationsDir, "0001_test", "CREATE TABLE test (id int);");

    await runMigrations(TEST_DB_URL, { migrationsDir, verbose: false });

    const testPool = new Pool({ connectionString: TEST_DB_URL });
    try {
      const result = await testPool.query("SELECT created_at FROM drizzle.__drizzle_migrations");
      expect(result.rows[0].created_at).toBe(timestamp.toString());
    } finally {
      await testPool.end();
    }
  });
});
