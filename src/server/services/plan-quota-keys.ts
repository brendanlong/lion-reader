/**
 * Redis key names for plan quota buckets (`consumePlanQuota`). Dependency-free
 * like `site-status-keys.ts`, so the deploy-time cache clear
 * (`src/server/redis/clear-cache.ts`) can skip them: a quota's allowance spans
 * a day, so dropping the buckets on every deploy would hand every user a fresh
 * burst.
 */

export const PLAN_QUOTA_KEY_PREFIX = "lion-reader:plan-quota:";

export function planQuotaKey(quota: string, userId: string): string {
  return `${PLAN_QUOTA_KEY_PREFIX}${quota}:${userId}`;
}
