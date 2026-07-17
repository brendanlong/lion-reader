/**
 * Seeds a benchmark database with N synthetic users whose data shape matches
 * production (subs/user, entries, read/star rates from bench/config.ts, which
 * is overridden by bench/prod-params.json once characterize-prod.sql is run).
 *
 * Each user gets its OWN feeds (no cross-user sharing) so per-user queries scan
 * realistic volumes and there's no unrealistic cache sharing. A live session is
 * created per user and written to bench/sessions.json for the load driver.
 *
 * Usage:
 *   USERS=500 tsx bench/seed-bench.ts          # against $DATABASE_URL
 *
 * Run against the throwaway local DB:
 *   dotenv -e .env.local-services -- env USERS=500 tsx bench/seed-bench.ts
 *
 * Bulk inserts use generate_series in SQL (fast); mirrors
 * tests/integration/entries-perf.test.ts.
 */

import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/server/db/schema";
import { generateUuidv7 } from "../src/lib/uuidv7";
import { loadWorkload } from "./config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const USERS = Number(process.env.USERS ?? 200);
const w = loadWorkload().seed;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. Prefix with dotenv -e .env.local-services --");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
const db = drizzle(pool, { schema });

interface SeededSession {
  userId: string;
  email: string;
  sessionToken: string;
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function main() {
  const t0 = Date.now();
  const feedsPerUser = w.subsPerUser;
  const entriesPerUser = feedsPerUser * w.entriesPerFeed;
  console.log(
    `Seeding ${USERS} users × ${feedsPerUser} feeds × ${w.entriesPerFeed} entries ` +
      `= ${(USERS * entriesPerUser).toLocaleString()} entries total`
  );
  console.log(
    `  readFraction=${w.readFraction} starredFraction=${w.starredFraction} ` +
      `tags/user=${w.tagsPerUser} uncategorized=${w.uncategorizedSubs}`
  );

  console.log("Truncating existing data…");
  await db.execute(sql`TRUNCATE subscription_tags, tags, user_entries, entries,
    subscriptions, feeds, sessions, users CASCADE`);

  const sessions: SeededSession[] = [];

  // Process users in batches to bound memory / statement size.
  const USER_BATCH = 25;
  for (let start = 0; start < USERS; start += USER_BATCH) {
    const end = Math.min(start + USER_BATCH, USERS);

    for (let u = start; u < end; u++) {
      const userId = generateUuidv7();
      const email = `bench-${userId}@example.com`;
      const now = new Date();

      await db.insert(schema.users).values({
        id: userId,
        email,
        emailVerifiedAt: now,
        tosAgreedAt: now,
        privacyPolicyAgreedAt: now,
        notEuAgreedAt: now,
        lastActiveAt: now,
      });

      // Session (raw token in cookie, sha256 hash stored — mirrors createSession).
      const sessionToken = crypto.randomBytes(32).toString("base64url");
      await db.insert(schema.sessions).values({
        id: generateUuidv7(),
        userId,
        tokenHash: sha256Hex(sessionToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      sessions.push({ userId, email, sessionToken });

      // Tags.
      const tagIds: string[] = [];
      const tagValues = [];
      for (let t = 0; t < w.tagsPerUser; t++) {
        const id = generateUuidv7();
        tagIds.push(id);
        tagValues.push({ id, userId, name: `Tag ${t}` });
      }
      if (tagValues.length) await db.insert(schema.tags).values(tagValues);

      // Feeds (unique per user).
      const feedRows = await db.execute(sql`
        INSERT INTO feeds (id, type, url, title, last_fetched_at, last_entries_updated_at, next_fetch_at, created_at, updated_at)
        SELECT
          gen_random_uuid(), 'web',
          'https://bench-${sql.raw(userId.replace(/-/g, ""))}-' || i || '.example.com/feed.xml',
          'Bench Feed ' || i,
          now(), now(), now() + interval '1 hour', now(), now()
        FROM generate_series(1, ${feedsPerUser}) AS i
        RETURNING id
      `);
      const feedIds = feedRows.rows.map((r) => (r as { id: string }).id);

      // Subscriptions (one per feed).
      const subValues = feedIds.map((feedId) => ({
        id: generateUuidv7(),
        userId,
        feedId,
        subscribedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      }));
      await db.insert(schema.subscriptions).values(subValues);
      const subIds = subValues.map((s) => s.id);

      // Assign tags to all but `uncategorizedSubs` subscriptions.
      const taggedCount = Math.max(0, subIds.length - w.uncategorizedSubs);
      const stValues: { subscriptionId: string; tagId: string }[] = [];
      for (let i = 0; i < taggedCount; i++) {
        stValues.push({ subscriptionId: subIds[i], tagId: tagIds[i % tagIds.length] });
      }
      if (stValues.length) await db.insert(schema.subscriptionTags).values(stValues);

      // Entries for this user's feeds (bulk via generate_series).
      await db.execute(sql`
        INSERT INTO entries (id, feed_id, type, guid, title, content_cleaned, content_hash,
                            fetched_at, published_at, last_seen_at, created_at, updated_at)
        SELECT
          gen_random_uuid(), f.id, 'web',
          f.id || '-' || e.i, 'Entry ' || e.i,
          'Test content for entry ' || e.i || '. Lorem ipsum dolor sit amet, consectetur.',
          f.id || '-' || e.i,
          now() - ((${w.entriesPerFeed} - e.i) || ' minutes')::interval,
          now() - ((${w.entriesPerFeed} - e.i) || ' minutes')::interval,
          now(), now(), now()
        FROM (SELECT unnest(${`{${feedIds.join(",")}}`}::uuid[]) AS id) f
        CROSS JOIN generate_series(1, ${w.entriesPerFeed}) AS e(i)
      `);

      // user_entries: read set by a per-feed fraction (deterministic); starred
      // by a Bernoulli draw so the target fraction holds even when
      // starredFraction * entriesPerFeed < 1 (e.g. 1% of 50 = 0.5/feed — a
      // per-feed modulus would round to zero starred, #starred-bug).
      await db.execute(sql`
        INSERT INTO user_entries (user_id, entry_id, read, starred, read_changed_at, starred_changed_at, updated_at, published_or_fetched_at)
        SELECT
          ${userId}::uuid, e.id,
          (row_number() OVER (PARTITION BY e.feed_id ORDER BY e.id))::float
            / ${w.entriesPerFeed} <= ${w.readFraction},
          random() < ${w.starredFraction},
          e.published_at, e.published_at, now(),
          COALESCE(e.published_at, e.fetched_at)
        FROM entries e
        WHERE e.feed_id = ANY(${`{${feedIds.join(",")}}`}::uuid[])
      `);
    }
    console.log(`  seeded ${end}/${USERS} users (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  console.log("ANALYZE…");
  await db.execute(
    sql`ANALYZE users, sessions, feeds, subscriptions, subscription_tags, tags, entries, user_entries`
  );

  const outPath = join(__dirname, "sessions.json");
  writeFileSync(
    outPath,
    JSON.stringify({ baseUrlHint: "set at run time", users: sessions }, null, 0)
  );
  console.log(`Wrote ${sessions.length} sessions -> ${outPath}`);

  // Size report.
  const sizes = await db.execute(sql`
    SELECT relname AS t, n_live_tup AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size
    FROM pg_stat_user_tables WHERE schemaname='public'
    ORDER BY pg_total_relation_size(relid) DESC LIMIT 8
  `);
  console.log("Table sizes:");
  for (const r of sizes.rows) {
    const row = r as { t: string; rows: number; size: string };
    console.log(`  ${row.t.padEnd(20)} ${String(row.rows).padStart(12)} rows  ${row.size}`);
  }
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
