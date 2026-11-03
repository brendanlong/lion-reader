/**
 * Plans: what a user may use. Every per-user quota reads its limit here, by
 * the user's `users.plan` (#2222); a `null` limit means no limit.
 *
 * Admins set a user's plan. New accounts get the instance's default plan
 * (`DEFAULT_PLAN`), which is `unlimited` unless the operator chooses one.
 */

export const PLAN_IDS = ["free", "paid", "unlimited"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  /** Active subscriptions and collections (the saved subscription doesn't count). */
  maxSubscriptions: number | null;
  /** Email addresses for receiving newsletters. */
  maxIngestAddresses: number | null;
}

export const PLAN_NAMES: Record<PlanId, string> = {
  free: "Free",
  paid: "Paid",
  unlimited: "Unlimited",
};

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    maxSubscriptions: 150,
    maxIngestAddresses: 1,
  },
  paid: {
    maxSubscriptions: 1000,
    maxIngestAddresses: 5,
  },
  unlimited: {
    maxSubscriptions: null,
    maxIngestAddresses: null,
  },
};

export function isPlanId(value: string): value is PlanId {
  return (PLAN_IDS as readonly string[]).includes(value);
}
