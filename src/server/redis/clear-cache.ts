/**
 * Deploy-time Redis cache clear.
 *
 * The migration step (`scripts/migrate.ts`, run as Fly's `release_command` on
 * every deploy) clears cached Redis data so it can't go stale against the new
 * schema. It used to call `flushdb()`, which wiped the **entire** Redis DB —
 * including the two durable site-status keys (announcement banner + maintenance
 * mode). Those are the source of truth, not a cache, so a deploy silently
 * dropped an admin's announcement and un-toggled admin-set maintenance mode.
 *
 * This clears everything **except** the `lion-reader:site-status:*` keys. We
 * never write those keys here (we only skip them), so a maintenance/announcement
 * toggle made on the still-running old machines during the release is preserved
 * as-is — no read-then-restore race. Everything else swept here is cache /
 * ephemeral (sessions, SSE channels, OAuth state, rate limits) and safe to drop.
 *
 * The Discord bot's user → API-token links used to be the exception here: they
 * lived only in Redis (`discord:token:*`) and were wiped on every deploy. They
 * now live durably in Postgres (`discord_api_token_links`, issue #1370), so
 * there is nothing Discord-related left to preserve on this path.
 */

import type Redis from "ioredis";
import { SITE_STATUS_KEY_PREFIX } from "@/server/services/site-status-keys";

export interface ClearRedisCacheResult {
  /** Number of keys removed (as reported by UNLINK). */
  deleted: number;
  /** Number of preserved site-status keys seen (may over-count under rehash). */
  preserved: number;
}

/**
 * Deletes every key in the connected Redis DB except the durable site-status
 * flags. Uses a non-blocking SCAN + UNLINK sweep so it never stalls Redis for
 * other clients the way `flushdb()` (or a big blocking `DEL`) can.
 */
export async function clearRedisCacheExceptSiteStatus(
  redis: Redis
): Promise<ClearRedisCacheResult> {
  let cursor = "0";
  let deleted = 0;
  let preserved = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "COUNT", 500);
    cursor = nextCursor;

    const toDelete: string[] = [];
    for (const key of keys) {
      if (key.startsWith(SITE_STATUS_KEY_PREFIX)) {
        preserved++;
      } else {
        toDelete.push(key);
      }
    }

    if (toDelete.length > 0) {
      deleted += await redis.unlink(...toDelete);
    }
  } while (cursor !== "0");

  return { deleted, preserved };
}
