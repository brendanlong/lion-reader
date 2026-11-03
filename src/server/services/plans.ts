/**
 * Reading and setting a user's plan (`@/lib/plans`). Quota checks read limits
 * through {@link getUserPlanLimits}, so every entry point gets the same ones.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  PLAN_LIMITS,
  PLAN_QUOTA_NAMES,
  type PlanId,
  type PlanLimits,
  type PlanQuota,
} from "@/lib/plans";
import { consumeBucket } from "@/server/rate-limit";
import type { DbOrTx } from "@/server/db";
import { ingestAddresses, users } from "@/server/db/schema";
import { errors } from "@/server/errors";
import { countActiveSubscriptions } from "@/server/services/subscriptions";

async function getUserPlan(db: DbOrTx, userId: string): Promise<PlanId> {
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
  const rate = (await getUserPlanLimits(db, userId)).quotas[quota];
  if (rate === null) return;
  const result = await consumeBucket(
    `rate_limit:plan:${quota}:user:${userId}`,
    { capacity: rate.burst, refillRate: rate.perDay / SECONDS_PER_DAY },
    { cost }
  );
  if (!result.allowed) {
    throw errors.quotaExceeded(PLAN_QUOTA_NAMES[quota], result.retryAfterSeconds ?? 0);
  }
}

/**
 * Changes a user's plan. Moving to a smaller plan never deletes anything: a
 * user over a new limit just can't add more until they're back under it.
 */
export async function setUserPlan(db: DbOrTx, userId: string, plan: PlanId): Promise<void> {
  const updated = await db
    .update(users)
    .set({ plan, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (updated.length === 0) throw errors.notFound("User");
}

export interface PlanUsage {
  plan: PlanId;
  limits: PlanLimits;
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
    usage: { subscriptions: subscriptionCount, ingestAddresses: addressCount },
  };
}

/** The user's ingest addresses that count toward the plan's limit. */
export async function countIngestAddresses(db: DbOrTx, userId: string): Promise<number> {
  const [{ addressCount }] = await db
    .select({ addressCount: sql<number>`count(*)::int` })
    .from(ingestAddresses)
    .where(and(eq(ingestAddresses.userId, userId), isNull(ingestAddresses.deletedAt)));
  return addressCount;
}
