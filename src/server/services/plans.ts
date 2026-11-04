/**
 * Reading and setting a user's plan (`@/lib/plans`). Quota checks read limits
 * through {@link getUserPlanLimits}, so every entry point gets the same ones.
 */

import { eq } from "drizzle-orm";
import {
  PLAN_LIMITS,
  PLAN_QUOTAS,
  quotaNameInSentence,
  type PlanId,
  type PlanLimits,
  type PlanQuota,
} from "@/lib/plans";
import { consumeBucket } from "@/server/rate-limit";
import { getRedisClient } from "@/server/redis";
import { logger } from "@/lib/logger";
import { planQuotaKey } from "@/server/services/plan-quota-keys";
import { planServerKeyModels } from "@/server/services/server-key-models";
import type { DbOrTx } from "@/server/db";
import { users } from "@/server/db/schema";
import { errors } from "@/server/errors";
import { countActiveSubscriptions } from "@/server/services/subscriptions";
import { countIngestAddresses } from "@/server/services/ingest-addresses";

export async function getUserPlan(db: DbOrTx, userId: string): Promise<PlanId> {
  const [row] = await db
    .select({ plan: users.plan })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw errors.notFound("User");
  return row.plan;
}

export async function getUserPlanLimits(db: DbOrTx, userId: string): Promise<PlanLimits> {
  return PLAN_LIMITS[await getUserPlan(db, userId)];
}

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Takes `cost` of the user's `quota` (`PLAN_QUOTAS`), or throws
 * `QUOTA_EXCEEDED` saying when more will be available. Charged before the work,
 * so an attempt that fails still counts. Like the other rate limits, it allows
 * the work when Redis is down.
 */
export async function consumePlanQuota(
  db: DbOrTx,
  userId: string,
  quota: PlanQuota,
  cost = 1
): Promise<void> {
  await consumeQuota(userId, await getUserPlanLimits(db, userId), quota, cost);
}

/** {@link consumePlanQuota} with the user's plan limits already loaded. */
export async function consumeQuota(
  userId: string,
  limits: PlanLimits,
  quota: PlanQuota,
  cost = 1
): Promise<void> {
  const rate = limits.quotas[quota];
  if (rate === null) return;
  if (rate === "excluded") throw errors.notInPlan(quotaNameInSentence(quota));
  const result = await consumeBucket(
    planQuotaKey(quota, userId),
    { capacity: rate.burst, refillRate: rate.perDay / SECONDS_PER_DAY },
    { cost }
  );
  if (!result.allowed) {
    throw errors.quotaExceeded(quotaNameInSentence(quota), result.retryAfterSeconds ?? 0);
  }
}

/**
 * Changes a user's plan. Moving to a smaller plan never deletes anything: a
 * user over a new limit just can't add more until they're back under it.
 * Their quotas start full on the new plan, so an upgrade takes effect at
 * once rather than refilling from what the old plan left.
 */
export async function setUserPlan(db: DbOrTx, userId: string, plan: PlanId): Promise<void> {
  const updated = await db
    .update(users)
    .set({ plan, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (updated.length === 0) throw errors.notFound("User");
  try {
    await getRedisClient()?.del(...PLAN_QUOTAS.map((quota) => planQuotaKey(quota, userId)));
  } catch (error) {
    // The plan changed; the old buckets just refill on their own.
    logger.warn("Failed to reset quotas after a plan change", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface PlanUsage {
  plan: PlanId;
  limits: PlanLimits;
  /** The models the plan may run on the server's AI keys; null for all. */
  serverKeyModels: readonly string[] | null;
  usage: {
    subscriptions: number;
    ingestAddresses: number;
  };
}

/** A user's plan, its limits, and how much of each the user is using. */
export async function getPlanUsage(db: DbOrTx, userId: string): Promise<PlanUsage> {
  const [plan, subscriptionCount, addressCount] = await Promise.all([
    getUserPlan(db, userId),
    countActiveSubscriptions(db, userId),
    countIngestAddresses(db, userId),
  ]);
  return {
    plan,
    limits: PLAN_LIMITS[plan],
    serverKeyModels: planServerKeyModels(plan),
    usage: { subscriptions: subscriptionCount, ingestAddresses: addressCount },
  };
}
