/**
 * Redis key names for the site-status flags (announcement banner + maintenance
 * mode).
 *
 * Kept in a tiny, dependency-free module so the deploy migration script
 * (`scripts/migrate.ts`) can import the prefix to **preserve** these keys when
 * it clears the rest of the Redis cache — without pulling the logger / Sentry /
 * redis-client module graph into its esbuild bundle. These flags are the source
 * of truth (not a cache), so they must survive a deploy. See `site-status.ts`
 * for the read/write logic and `src/server/redis/clear-cache.ts` for the
 * deploy-time clear that skips this prefix.
 */

/** Shared prefix for every durable site-status key. */
export const SITE_STATUS_KEY_PREFIX = "lion-reader:site-status:";

export const MAINTENANCE_KEY = `${SITE_STATUS_KEY_PREFIX}maintenance`;
export const ANNOUNCEMENT_KEY = `${SITE_STATUS_KEY_PREFIX}announcement`;
