#!/usr/bin/env npx tsx
/**
 * Feedbin to Lion Reader Migration Tool
 *
 * This script fetches unread articles from Feedbin and generates SQL to import them
 * into Lion Reader. It matches feeds by URL between the two systems.
 *
 * Usage:
 *   FEEDBIN_EMAIL=user@example.com FEEDBIN_PASSWORD=xxx pnpm tsx scripts/feedbin-import.ts [options]
 *
 * Options:
 *   --dry-run              Show what would be imported without generating SQL
 *   --user-id=<uuid>       Lion Reader user ID to import for (required unless --dry-run)
 *   --output=<file>        Output SQL file (default: stdout)
 *   --include-read         Also import read entries (default: unread only)
 *
 * Environment:
 *   FEEDBIN_EMAIL          Feedbin account email
 *   FEEDBIN_PASSWORD       Feedbin account password
 *   DATABASE_URL           Lion Reader database URL (for fetching existing feeds)
 */

import { createHash, randomBytes } from "crypto";

// ============================================================================
// Types
// ============================================================================

interface FeedbinSubscription {
  id: number;
  feed_id: number;
  title: string;
  feed_url: string;
  site_url: string;
  created_at: string;
}

interface FeedbinEntry {
  id: number;
  feed_id: number;
  title: string | null;
  author: string | null;
  url: string | null;
  content: string | null;
  summary: string | null;
  published: string;
  created_at: string;
}

interface LionReaderSubscription {
  id: string;
  feedId: string;
  feedUrl: string | null;
  title: string | null;
}

interface MatchedFeed {
  feedbinSubscription: FeedbinSubscription;
  lionReaderSubscription: LionReaderSubscription;
}

// ============================================================================
// Configuration
// ============================================================================

const FEEDBIN_API_BASE = "https://api.feedbin.com/v2";

function getConfig() {
  const email = process.env.FEEDBIN_EMAIL;
  const password = process.env.FEEDBIN_PASSWORD;

  if (!email || !password) {
    console.error("Error: FEEDBIN_EMAIL and FEEDBIN_PASSWORD environment variables are required");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const includeRead = args.includes("--include-read");

  const userIdArg = args.find((a) => a.startsWith("--user-id="));
  const userId = userIdArg?.split("=")[1];

  const outputArg = args.find((a) => a.startsWith("--output="));
  const outputFile = outputArg?.split("=")[1];

  if (!dryRun && !userId) {
    console.error("Error: --user-id=<uuid> is required unless using --dry-run");
    process.exit(1);
  }

  return {
    email,
    password,
    dryRun,
    includeRead,
    userId: userId ?? "",
    outputFile,
  };
}

// ============================================================================
// Feedbin API Client
// ============================================================================

class FeedbinClient {
  private auth: string;

  constructor(email: string, password: string) {
    this.auth = Buffer.from(`${email}:${password}`).toString("base64");
  }

  private async fetch<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${FEEDBIN_API_BASE}${endpoint}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    }

    const urlStr = url.toString();
    console.error(`[Feedbin API] GET ${urlStr}`);
    const startTime = Date.now();

    const response = await fetch(urlStr, {
      headers: {
        Authorization: `Basic ${this.auth}`,
        "Content-Type": "application/json",
      },
    });

    const elapsed = Date.now() - startTime;
    console.error(
      `[Feedbin API] Response: ${response.status} ${response.statusText} (${elapsed}ms)`
    );

    // Log rate limit headers if present
    const rateLimit = response.headers.get("X-RateLimit-Limit");
    const rateRemaining = response.headers.get("X-RateLimit-Remaining");
    if (rateLimit || rateRemaining) {
      console.error(`[Feedbin API] Rate limit: ${rateRemaining}/${rateLimit} remaining`);
    }

    if (!response.ok) {
      const body = await response.text();
      console.error(`[Feedbin API] Error body: ${body}`);
      throw new Error(`Feedbin API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Fetches all pages of a paginated endpoint.
   */
  private async fetchAllPages<T>(endpoint: string, params?: Record<string, string>): Promise<T[]> {
    const allItems: T[] = [];
    let page = 1;
    const perPage = "100";

    console.error(`[Feedbin API] Starting paginated fetch for ${endpoint}`);

    while (true) {
      const pageParams = { ...params, page: String(page), per_page: perPage };
      console.error(`[Feedbin API] Fetching page ${page}...`);
      const items = await this.fetch<T[]>(endpoint, pageParams);
      allItems.push(...items);
      console.error(
        `[Feedbin API] Page ${page}: received ${items.length} items (total: ${allItems.length})`
      );

      if (items.length < 100) {
        console.error(`[Feedbin API] Pagination complete: ${allItems.length} total items`);
        break;
      }
      page++;
    }

    return allItems;
  }

  async getSubscriptions(): Promise<FeedbinSubscription[]> {
    // Subscriptions endpoint returns all subscriptions without pagination
    return this.fetch<FeedbinSubscription[]>("/subscriptions.json");
  }

  async getUnreadEntries(): Promise<FeedbinEntry[]> {
    return this.fetchAllPages<FeedbinEntry>("/entries.json", { read: "false" });
  }

  async getAllEntries(): Promise<FeedbinEntry[]> {
    return this.fetchAllPages<FeedbinEntry>("/entries.json");
  }
}

// ============================================================================
// Lion Reader Database
// ============================================================================

async function getLionReaderSubscriptions(userId: string): Promise<LionReaderSubscription[]> {
  // Import dynamically to avoid requiring database connection in dry-run mode
  const { db } = await import("@/server/db");
  const { userFeeds } = await import("@/server/db/schema");
  const { eq } = await import("drizzle-orm");

  const subscriptions = await db
    .select({
      id: userFeeds.id,
      feedId: userFeeds.feedId,
      feedUrl: userFeeds.url,
      title: userFeeds.title,
    })
    .from(userFeeds)
    .where(eq(userFeeds.userId, userId));

  return subscriptions;
}

// ============================================================================
// URL Matching
// ============================================================================

/**
 * Normalizes a feed URL for comparison.
 * Handles common variations like http vs https, trailing slashes, www prefix.
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Normalize to https, remove www, remove trailing slash
    let normalized = parsed.hostname.replace(/^www\./, "") + parsed.pathname.replace(/\/$/, "");
    // Remove common feed path variations
    normalized = normalized
      .replace(/\/feed\/?$/, "")
      .replace(/\/rss\/?$/, "")
      .replace(/\/atom\/?$/, "");
    return normalized.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function matchFeeds(
  feedbinSubscriptions: FeedbinSubscription[],
  lionReaderSubscriptions: LionReaderSubscription[]
): { matched: MatchedFeed[]; unmatched: FeedbinSubscription[] } {
  const matched: MatchedFeed[] = [];
  const unmatched: FeedbinSubscription[] = [];

  // Create a map of normalized URLs to Lion Reader subscriptions
  const lrByUrl = new Map<string, LionReaderSubscription>();
  for (const sub of lionReaderSubscriptions) {
    if (sub.feedUrl) {
      lrByUrl.set(normalizeUrl(sub.feedUrl), sub);
    }
  }

  for (const fbSub of feedbinSubscriptions) {
    const normalizedFbUrl = normalizeUrl(fbSub.feed_url);
    const lrSub = lrByUrl.get(normalizedFbUrl);

    if (lrSub) {
      matched.push({
        feedbinSubscription: fbSub,
        lionReaderSubscription: lrSub,
      });
    } else {
      unmatched.push(fbSub);
    }
  }

  return { matched, unmatched };
}

// ============================================================================
// SQL Generation
// ============================================================================

/**
 * Generates a UUIDv7 with a specific timestamp.
 * This ensures entries are ordered correctly by their published date.
 */
function generateUuidv7WithTimestamp(timestamp: Date): string {
  const ts = timestamp.getTime();
  const bytes = randomBytes(16);

  // Set the timestamp (first 48 bits / 6 bytes)
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  // Set version to 7 (high nibble of byte 6)
  bytes[6] = (bytes[6] & 0x0f) | 0x70;

  // Set variant to 10xx (high 2 bits of byte 8)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  // Convert to UUID string format
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Generates a content hash matching Lion Reader's format.
 */
function generateContentHash(title: string | null, content: string | null): string {
  const titleStr = title ?? "";
  const contentStr = content ?? "";
  const hashInput = `${titleStr}\n${contentStr}`;
  return createHash("sha256").update(hashInput, "utf8").digest("hex");
}

/**
 * Derives a GUID for an entry, matching Lion Reader's logic.
 * Returns null for entries without URLs (which should be skipped).
 */
function deriveGuid(entry: FeedbinEntry): string | null {
  return entry.url;
}

/**
 * Escapes a string for SQL.
 */
function sqlEscape(value: string | null): string {
  if (value === null) return "NULL";
  // Escape single quotes by doubling them
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Truncates text to create a summary (300 chars, no HTML).
 */
function createSummary(content: string | null): string | null {
  if (!content) return null;

  // Strip HTML tags
  const text = content
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= 300) return text;
  return text.slice(0, 297) + "...";
}

interface GeneratedSQL {
  entriesSQL: string[];
  userEntriesSQL: string[];
  stats: {
    totalEntries: number;
    newEntries: number;
    existingEntries: number;
    skippedEntries: number;
  };
}

async function generateSQL(
  entries: FeedbinEntry[],
  matchedFeeds: MatchedFeed[],
  userId: string
): Promise<GeneratedSQL> {
  // Create a map of Feedbin feed_id to Lion Reader subscription
  const feedMap = new Map<number, LionReaderSubscription>();
  for (const match of matchedFeeds) {
    feedMap.set(match.feedbinSubscription.feed_id, match.lionReaderSubscription);
  }

  // Get existing entries to avoid duplicates
  const { db } = await import("@/server/db");
  const { entries: entriesTable, userEntries } = await import("@/server/db/schema");
  const { inArray, eq } = await import("drizzle-orm");

  // Get feed IDs we're importing into
  const feedIds = [...new Set(matchedFeeds.map((m) => m.lionReaderSubscription.feedId))];

  // Fetch existing entries by GUID for these feeds
  const existingEntries = await db
    .select({
      id: entriesTable.id,
      feedId: entriesTable.feedId,
      guid: entriesTable.guid,
    })
    .from(entriesTable)
    .where(inArray(entriesTable.feedId, feedIds));

  const existingByFeedAndGuid = new Map<string, string>();
  for (const e of existingEntries) {
    existingByFeedAndGuid.set(`${e.feedId}:${e.guid}`, e.id);
  }

  // Fetch existing user_entries to avoid duplicates
  const existingUserEntries = await db
    .select({ entryId: userEntries.entryId })
    .from(userEntries)
    .where(eq(userEntries.userId, userId));

  const existingUserEntryIds = new Set(existingUserEntries.map((e) => e.entryId));

  const entriesSQL: string[] = [];
  const userEntriesSQL: string[] = [];
  let newEntries = 0;
  let existingEntriesCount = 0;
  let skippedEntries = 0;

  for (const entry of entries) {
    const lrSub = feedMap.get(entry.feed_id);
    if (!lrSub) continue; // Entry from unmatched feed

    const guid = deriveGuid(entry);
    if (!guid) {
      // Skip entries without URLs (e.g., email/newsletter entries)
      skippedEntries++;
      continue;
    }
    const existingEntryId = existingByFeedAndGuid.get(`${lrSub.feedId}:${guid}`);

    if (existingEntryId) {
      // Entry already exists, just add user_entry if needed
      existingEntriesCount++;
      if (!existingUserEntryIds.has(existingEntryId)) {
        userEntriesSQL.push(
          `INSERT INTO user_entries (user_id, entry_id, read, starred) ` +
            `VALUES (${sqlEscape(userId)}, ${sqlEscape(existingEntryId)}, false, false) ` +
            `ON CONFLICT DO NOTHING;`
        );
        existingUserEntryIds.add(existingEntryId);
      }
    } else {
      // New entry
      newEntries++;
      const publishedAt = new Date(entry.published);
      const createdAt = new Date(entry.created_at);
      const entryId = generateUuidv7WithTimestamp(publishedAt);
      const contentHash = generateContentHash(entry.title, entry.content);
      const summary = createSummary(entry.content || entry.summary);

      entriesSQL.push(
        `INSERT INTO entries (id, feed_id, type, guid, url, title, author, content_original, summary, published_at, fetched_at, last_seen_at, content_hash, created_at, updated_at) ` +
          `VALUES (` +
          `${sqlEscape(entryId)}, ` +
          `${sqlEscape(lrSub.feedId)}, ` +
          `'web', ` +
          `${sqlEscape(guid)}, ` +
          `${sqlEscape(entry.url)}, ` +
          `${sqlEscape(entry.title)}, ` +
          `${sqlEscape(entry.author)}, ` +
          `${sqlEscape(entry.content)}, ` +
          `${sqlEscape(summary)}, ` +
          `${sqlEscape(publishedAt.toISOString())}, ` +
          `${sqlEscape(createdAt.toISOString())}, ` +
          `${sqlEscape(createdAt.toISOString())}, ` +
          `${sqlEscape(contentHash)}, ` +
          `NOW(), NOW()` +
          `) ON CONFLICT (feed_id, guid) DO NOTHING;`
      );

      userEntriesSQL.push(
        `INSERT INTO user_entries (user_id, entry_id, read, starred) ` +
          `VALUES (${sqlEscape(userId)}, ${sqlEscape(entryId)}, false, false) ` +
          `ON CONFLICT DO NOTHING;`
      );

      // Track so we don't create duplicates within this import
      existingByFeedAndGuid.set(`${lrSub.feedId}:${guid}`, entryId);
      existingUserEntryIds.add(entryId);
    }
  }

  return {
    entriesSQL,
    userEntriesSQL,
    stats: {
      totalEntries: entries.length,
      newEntries,
      existingEntries: existingEntriesCount,
      skippedEntries,
    },
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const config = getConfig();

  console.error("Feedbin to Lion Reader Migration Tool");
  console.error("=====================================\n");

  // Connect to Feedbin
  console.error("Connecting to Feedbin...");
  const feedbin = new FeedbinClient(config.email, config.password);

  // Fetch Feedbin subscriptions
  console.error("Fetching Feedbin subscriptions...");
  const feedbinSubscriptions = await feedbin.getSubscriptions();
  console.error(`  Found ${feedbinSubscriptions.length} subscriptions\n`);

  if (config.dryRun) {
    // In dry-run mode, just show subscriptions and exit
    console.error("Dry run mode - showing Feedbin subscriptions:\n");
    for (const sub of feedbinSubscriptions) {
      console.error(`  - ${sub.title}`);
      console.error(`    URL: ${sub.feed_url}`);
    }

    console.error("\nTo generate import SQL, run without --dry-run and provide --user-id");
    return;
  }

  // Fetch Lion Reader subscriptions
  console.error("Fetching Lion Reader subscriptions...");
  const lrSubscriptions = await getLionReaderSubscriptions(config.userId);
  console.error(`  Found ${lrSubscriptions.length} subscriptions\n`);

  // Match feeds
  console.error("Matching feeds by URL...");
  const { matched, unmatched } = matchFeeds(feedbinSubscriptions, lrSubscriptions);
  console.error(`  Matched: ${matched.length} feeds`);
  console.error(`  Unmatched: ${unmatched.length} feeds\n`);

  if (matched.length === 0) {
    console.error(
      "No matching feeds found. Make sure you have subscribed to the same feeds in Lion Reader."
    );
    console.error("\nUnmatched Feedbin subscriptions:");
    for (const sub of unmatched) {
      console.error(`  - ${sub.title}: ${sub.feed_url}`);
    }
    process.exit(1);
  }

  if (unmatched.length > 0) {
    console.error("Unmatched Feedbin subscriptions (will be skipped):");
    for (const sub of unmatched) {
      console.error(`  - ${sub.title}: ${sub.feed_url}`);
    }
    console.error("");
  }

  console.error("Matched feeds:");
  for (const match of matched) {
    console.error(`  - ${match.feedbinSubscription.title}`);
    console.error(`    Feedbin: ${match.feedbinSubscription.feed_url}`);
    console.error(`    Lion Reader: ${match.lionReaderSubscription.feedUrl}`);
  }
  console.error("");

  // Fetch entries
  let entries: FeedbinEntry[];
  if (config.includeRead) {
    console.error("Fetching all entries...");
    entries = await feedbin.getAllEntries();
  } else {
    console.error("Fetching unread entries...");
    entries = await feedbin.getUnreadEntries();
  }
  console.error(`  Fetched ${entries.length} entries\n`);

  // Filter to only entries from matched feeds
  const matchedFeedIds = new Set(matched.map((m) => m.feedbinSubscription.feed_id));
  const relevantEntries = entries.filter((e) => matchedFeedIds.has(e.feed_id));
  console.error(`  ${relevantEntries.length} entries are from matched feeds\n`);

  if (relevantEntries.length === 0) {
    console.error("No entries to import from matched feeds.");
    process.exit(0);
  }

  // Generate SQL
  console.error("Generating SQL...");
  const { entriesSQL, userEntriesSQL, stats } = await generateSQL(
    relevantEntries,
    matched,
    config.userId
  );

  console.error(`  New entries: ${stats.newEntries}`);
  console.error(`  Existing entries (adding visibility): ${stats.existingEntries}`);
  if (stats.skippedEntries > 0) {
    console.error(`  Skipped entries (no URL): ${stats.skippedEntries}`);
  }
  console.error("");

  // Output SQL
  const sql = [
    "-- Feedbin to Lion Reader Import",
    `-- Generated: ${new Date().toISOString()}`,
    `-- User ID: ${config.userId}`,
    `-- New entries: ${stats.newEntries}`,
    `-- Existing entries: ${stats.existingEntries}`,
    `-- Skipped entries (no URL): ${stats.skippedEntries}`,
    "",
    "BEGIN;",
    "",
    "-- Insert new entries",
    ...entriesSQL,
    "",
    "-- Insert user_entries (visibility records)",
    ...userEntriesSQL,
    "",
    "COMMIT;",
  ].join("\n");

  if (config.outputFile) {
    const fs = await import("fs");
    fs.writeFileSync(config.outputFile, sql);
    console.error(`SQL written to: ${config.outputFile}`);
  } else {
    console.log(sql);
  }

  console.error("\nDone!");
  console.error("To apply the import, run:");
  if (config.outputFile) {
    console.error(`  psql $DATABASE_URL < ${config.outputFile}`);
  } else {
    console.error("  pnpm tsx scripts/feedbin-import.ts --user-id=... --output=import.sql");
    console.error("  psql $DATABASE_URL < import.sql");
  }

  // Clean up database connection
  const { db } = await import("@/server/db");
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
