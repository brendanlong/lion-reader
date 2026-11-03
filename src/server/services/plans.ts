/**
 * Reading and setting a user's plan (`@/lib/plans`). Quota checks read limits
 * through {@link getUserPlanLimits}, so every entry point gets the same ones.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { PLAN_LIMITS, type PlanId, type PlanLimits } from "@/lib/plans";
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
