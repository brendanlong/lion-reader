/**
 * Custom migration runner that replaces drizzle-kit migrate.
 *
 * Key differences from drizzle-kit:
 * - Each migration runs in its own transaction (drizzle-kit runs all in one)
 * - Better error messages and hash verification
 * - Compatible with existing drizzle migration format
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { Pool, PoolClient } from "pg";

// ============================================================================
// Types
// ============================================================================

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

interface AppliedMigration {
  id: number;
  hash: string;
  created_at: bigint;
}

export interface MigrationOptions {
  /** Directory containing migration SQL files and meta/_journal.json */
  migrationsDir?: string;
  /** Schema name for migrations table (default: "drizzle") */
  migrationsSchema?: string;
  /** Table name for migrations tracking (default: "__drizzle_migrations") */
  migrationsTable?: string;
  /** Whether to log progress (default: true) */
  verbose?: boolean;
}

interface ResolvedOptions {
  migrationsDir: string;
  migrationsSchema: string;
  migrationsTable: string;
  verbose: boolean;
}

// ============================================================================
// Pure Functions (exported for testing)
// ============================================================================

/**
 * Compute the hash of a migration file the same way drizzle-kit does.
 * Drizzle uses SHA-256 of the SQL content.
 */
export function computeHash(sql: string): string {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

/**
 * Split a migration SQL file into individual statements.
 * Drizzle uses "--> statement-breakpoint" as a separator.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse a journal JSON string into a Journal object.
 */
export function parseJournal(content: string): Journal {
  return JSON.parse(content) as Journal;
}

// ============================================================================
// File System Functions
// ============================================================================

/**
 * Load the migration journal from disk.
 */
function loadJournal(migrationsDir: string): Journal {
  const journalPath = path.join(migrationsDir, "meta", "_journal.json");
  const content = fs.readFileSync(journalPath, "utf-8");
  return parseJournal(content);
}

/**
 * Load a migration SQL file from disk.
 */
function loadMigrationSql(migrationsDir: string, tag: string): string {
  const filePath = path.join(migrationsDir, `${tag}.sql`);
  return fs.readFileSync(filePath, "utf-8");
}

// ============================================================================
// Database Functions
// ============================================================================

/**
 * Ensure the migrations schema and table exist.
 * Table structure matches drizzle-kit exactly for compatibility.
 */
async function ensureMigrationsTable(
  client: PoolClient,
  schema: string,
  table: string
): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

/**
 * Get all applied migrations from the database.
 */
async function getAppliedMigrations(
  client: PoolClient,
  schema: string,
  table: string
): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(`
    SELECT id, hash, created_at
    FROM "${schema}"."${table}"
    ORDER BY id ASC
  `);
  return result.rows;
}

/**
 * Run a single migration in a transaction.
 * The migrations table is updated in the same transaction.
 */
async function runMigration(
  pool: Pool,
  schema: string,
  table: string,
  sql: string,
  hash: string,
  folderMillis: number
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Split and execute each statement
    const statements = splitStatements(sql);
    for (const statement of statements) {
      await client.query(statement);
    }

    // Record the migration in the same transaction
    // Use folderMillis (from journal.when) as created_at for drizzle compatibility
    await client.query(`INSERT INTO "${schema}"."${table}" (hash, created_at) VALUES ($1, $2)`, [
      hash,
      folderMillis,
    ]);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ============================================================================
// Main Migration Runner
// ============================================================================

function resolveOptions(options?: MigrationOptions): ResolvedOptions {
  return {
    migrationsDir: options?.migrationsDir ?? path.join(process.cwd(), "drizzle"),
    migrationsSchema: options?.migrationsSchema ?? "drizzle",
    migrationsTable: options?.migrationsTable ?? "__drizzle_migrations",
    verbose: options?.verbose ?? true,
  };
}

// Advisory lock ID for migrations (arbitrary but unique constant)
const MIGRATION_LOCK_ID = 8675309;

/**
 * Main migration runner.
 */
export async function runMigrations(
  databaseUrl: string,
  options?: MigrationOptions
): Promise<{ applied: string[]; skipped: string[] }> {
  const opts = resolveOptions(options);
  const pool = new Pool({ connectionString: databaseUrl });
  const applied: string[] = [];
  const skipped: string[] = [];

  const log = opts.verbose ? console.log.bind(console) : () => {};

  try {
    // Ensure migrations table exists
    const client = await pool.connect();
    try {
      await ensureMigrationsTable(client, opts.migrationsSchema, opts.migrationsTable);

      // Acquire advisory lock to prevent concurrent migration runs
      log("Acquiring migration lock...");
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
      const appliedMigrations = await getAppliedMigrations(
        client,
        opts.migrationsSchema,
        opts.migrationsTable
      );

      // Load journal to get list of all migrations
      const journal = loadJournal(opts.migrationsDir);

      // Verify already-applied migrations have matching hashes
      for (let i = 0; i < appliedMigrations.length; i++) {
        const appliedMigration = appliedMigrations[i];
        const journalEntry = journal.entries[i];

        if (!journalEntry) {
          throw new Error(
            `Migration ${i} exists in database but not in journal. ` +
              `This may indicate a corrupted migration state.`
          );
        }

        const sql = loadMigrationSql(opts.migrationsDir, journalEntry.tag);
        const expectedHash = computeHash(sql);

        if (appliedMigration.hash !== expectedHash) {
          throw new Error(
            `Hash mismatch for migration ${journalEntry.tag}:\n` +
              `  Expected: ${expectedHash}\n` +
              `  Found:    ${appliedMigration.hash}\n` +
              `This may indicate the migration file was modified after being applied.`
          );
        }

        skipped.push(journalEntry.tag);
      }

      // Get pending migrations
      const pendingMigrations = journal.entries.slice(appliedMigrations.length);

      if (pendingMigrations.length === 0) {
        log("No pending migrations.");
        return { applied, skipped };
      }

      log(`Found ${pendingMigrations.length} pending migration(s).`);

      // Run each pending migration
      for (const entry of pendingMigrations) {
        log(`Running migration: ${entry.tag}...`);

        const sql = loadMigrationSql(opts.migrationsDir, entry.tag);
        const hash = computeHash(sql);

        await runMigration(
          pool,
          opts.migrationsSchema,
          opts.migrationsTable,
          sql,
          hash,
          entry.when
        );

        applied.push(entry.tag);
        log(`  ✓ Applied ${entry.tag}`);
      }
    } finally {
      // Release advisory lock (also released automatically on disconnect)
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
      client.release();
    }

    return { applied, skipped };
  } finally {
    await pool.end();
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is not set");
    process.exit(1);
  }

  console.log("Running database migrations...\n");

  try {
    const { applied, skipped } = await runMigrations(databaseUrl);

    if (applied.length > 0) {
      console.log(`\n✓ Applied ${applied.length} migration(s)`);
    }
    if (skipped.length > 0) {
      console.log(`  Skipped ${skipped.length} already-applied migration(s)`);
    }
  } catch (error) {
    console.error("\nMigration failed:", error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}
