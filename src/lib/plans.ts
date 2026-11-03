/**
 * Plans: what a user may use. Every per-user quota reads its limit here, by
 * the user's `users.plan` (#2222); a `null` limit means no limit.
 *
 * Admins set a user's plan. New accounts get the instance's default plan
 * (`DEFAULT_PLAN`), which is `unlimited` unless the operator chooses one.
 */

export const PLAN_IDS = ["free", "paid", "unlimited"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/**
 * The plan quotas that refill continuously: a user may use up to `burst` at
 * once, and the allowance refills at `perDay`, spread evenly over the day, so
 * someone who runs out waits minutes for the next one rather than a day.
 */
export const PLAN_QUOTAS = ["pageFetches", "fileConversions"] as const;
export type PlanQuota = (typeof PLAN_QUOTAS)[number];

export interface QuotaRate {
  burst: number;
  perDay: number;
}

export const PLAN_QUOTA_NAMES: Record<PlanQuota, string> = {
  /** Saving a link, fetching an article's full content, retrying a broken feed. */
  pageFetches: "Page fetches",
  /** Uploading a file (PDF, Word document, ebook, HTML, Markdown). */
  fileConversions: "File uploads",
};

export interface PlanLimits {
  /** Active subscriptions and collections (the saved subscription doesn't count). */
  maxSubscriptions: number | null;
  /** Email addresses for receiving newsletters. */
  maxIngestAddresses: number | null;
  quotas: Record<PlanQuota, QuotaRate | null>;
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
    quotas: {
      pageFetches: { burst: 50, perDay: 200 },
      fileConversions: { burst: 5, perDay: 10 },
    },
  },
  paid: {
    maxSubscriptions: 1000,
    maxIngestAddresses: 5,
    quotas: {
      pageFetches: { burst: 200, perDay: 2000 },
      fileConversions: { burst: 20, perDay: 100 },
    },
  },
  unlimited: {
    maxSubscriptions: null,
    maxIngestAddresses: null,
    quotas: { pageFetches: null, fileConversions: null },
  },
};

export function isPlanId(value: string): value is PlanId {
  return (PLAN_IDS as readonly string[]).includes(value);
}
