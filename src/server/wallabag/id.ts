/**
 * Wallabag ID Resolution
 *
 * A Wallabag entry id is the entry's stored compat serial —
 * `entries.greader_item_id`, the same global bigint serial the Google Reader
 * API uses for item ids (issue #1117). Wallabag ids used to be a 31-bit
 * SHA-256 hash of the entry UUID, which produced real user-visible collisions
 * (two entries sharing an id, with the reverse lookup's `limit(1)` returning
 * the wrong one); a stored serial is collision-free and reverses with a
 * unique-index seek. Wallabag clients re-synced from scratch when ids
 * switched from hashes to serials — accepted, matching the Google Reader
 * id migration.
 *
 * Serials are exposed as JSON numbers (Wallabag ids are plain integers), which
 * is exact while they stay under 2^53 — they increment by 1 from a shared
 * sequence, so that bound is not reachable in practice.
 */

import { eq, and } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { entries, visibleEntries } from "@/server/db/schema";
import { isInt64 } from "@/server/google-reader/id";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface ResolvedWallabagEntry {
  /** Lion Reader entry UUID. */
  id: string;
  /** Wallabag integer id (the entry's stored serial). */
  wallabagId: number;
}

/**
 * Resolves the `{entry}` path parameter of the Wallabag single-entry routes to
 * an entry UUID plus its Wallabag integer id. Accepts either a Wallabag
 * numeric id or a Lion Reader UUID (clients that keep the `uid` we return).
 * Both forms resolve through `visible_entries`, so a client can only address
 * entries its user can see. Returns null for unknown/invisible entries and for
 * values that can't be a stored serial (non-numeric, or beyond bigint range —
 * which Postgres would reject as a parameter).
 *
 * Real Wallabag routes are `/api/entries/{entry}.{_format}` (the Android app and
 * others append a `.json` suffix), so a trailing `.json`/`.xml` format suffix is
 * stripped before resolution — otherwise `123.json` parses as neither a serial
 * nor a UUID and archiving/starring/deleting silently 404s (issue #1229).
 */
export async function resolveWallabagEntry(
  db: typeof dbType,
  userId: string,
  entryParam: string
): Promise<ResolvedWallabagEntry | null> {
  entryParam = entryParam.replace(/\.(json|xml)$/i, "");

  const selection = { id: visibleEntries.id, greaderItemId: visibleEntries.greaderItemId };

  let rows: Array<{ id: string; greaderItemId: bigint }>;
  if (UUID_PATTERN.test(entryParam)) {
    rows = await db
      .select(selection)
      .from(visibleEntries)
      .where(and(eq(visibleEntries.userId, userId), eq(visibleEntries.id, entryParam)))
      .limit(1);
  } else {
    if (!/^\d+$/.test(entryParam)) return null;
    const numericId = BigInt(entryParam);
    if (!isInt64(numericId)) return null;
    rows = await db
      .select(selection)
      .from(visibleEntries)
      .where(and(eq(visibleEntries.userId, userId), eq(visibleEntries.greaderItemId, numericId)))
      .limit(1);
  }

  const row = rows[0];
  return row ? { id: row.id, wallabagId: Number(row.greaderItemId) } : null;
}

/**
 * Looks up the Wallabag integer id for a known entry UUID — a primary-key seek
 * on `entries`. Used where a route already holds a verified entry id (a
 * just-saved article, an exists-by-URL hit) but the service result doesn't
 * carry the serial (`SavedArticle` stays bigint-free for the MCP/tRPC surfaces
 * that return it verbatim). Returns null if the entry vanished meanwhile.
 */
export async function entryIdToWallabagId(
  db: typeof dbType,
  entryId: string
): Promise<number | null> {
  const [row] = await db
    .select({ greaderItemId: entries.greaderItemId })
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1);

  return row ? Number(row.greaderItemId) : null;
}
