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
export const PLAN_QUOTAS = [
  "pageFetches",
  "fileConversions",
  "summaries",
  "narrationTextProcessing",
  "speechCharacters",
] as const;
export type PlanQuota = (typeof PLAN_QUOTAS)[number];

/** The quotas that count calls on the server's AI keys (a user's own key costs us nothing). */
export const AI_PLAN_QUOTAS: ReadonlySet<PlanQuota> = new Set([
  "summaries",
  "narrationTextProcessing",
  "speechCharacters",
]);

export interface QuotaRate {
  burst: number;
  perDay: number;
}

/**
 * A plan's quota: a {@link QuotaRate}, `null` for no limit, or `"excluded"`
 * when the plan doesn't include it at all (an AI feature still works on the
 * user's own key).
 */
export type QuotaLimit = QuotaRate | null | "excluded";

export const PLAN_QUOTA_NAMES: Record<PlanQuota, string> = {
  /** Saving a link, fetching an article's full content, retrying a broken feed. */
  pageFetches: "Page fetches",
  /** Uploading a file (PDF, Word document, ebook, HTML, Markdown). */
  fileConversions: "File uploads",
  /** Generating an article summary. */
  summaries: "AI summaries",
  /** Preparing an article's text for narration with a language model. */
  narrationTextProcessing: "Narration text cleanup",
  /** Characters spoken by cloud voices. */
  speechCharacters: "Cloud voice characters",
};

/**
 * A quota's name for the middle of a sentence: lower-cased, but an acronym
 * ("AI summaries") keeps its capitals.
 */
export function quotaNameInSentence(quota: PlanQuota): string {
  const name = PLAN_QUOTA_NAMES[quota];
  return /^[A-Z]{2}/.test(name) ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

export interface PlanLimits {
  /** Active subscriptions and collections (the saved subscription doesn't count). */
  maxSubscriptions: number | null;
  /** Email addresses for receiving newsletters. */
  maxIngestAddresses: number | null;
  /**
   * The models the plan may run on the server's AI keys, as `provider:model`
   * refs (`provider:*` for all of a provider's), within those the instance
   * allows (`server-key-models.ts`); null for every one it allows. Costs are
   * controlled here: the AI quotas count uses, not spend. A user's own key
   * isn't limited by it.
   */
  serverKeyModels: readonly string[] | null;
  /**
   * How OpenRouter picks a host for the plan's text calls on the server's
   * key: the cheapest, or the fastest. A user's own key always gets the
   * fastest.
   */
  serverKeyRouting: "cheapest" | "fastest";
  quotas: Record<PlanQuota, QuotaLimit>;
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
    // Only what costs us (almost) nothing: our own speech server, and
    // summaries on OpenRouter's cheapest gpt-oss-120b host. No failover onto
    // paid speech hosts.
    serverKeyModels: ["selfhosted:*", "openrouter:openai/gpt-oss-120b"],
    serverKeyRouting: "cheapest",
    quotas: {
      // Bursts above the daily refill: a new user's first session is
      // generous, and steady use is still held to the daily rate.
      pageFetches: { burst: 100, perDay: 200 },
      fileConversions: { burst: 20, perDay: 10 },
      summaries: { burst: 50, perDay: 5 },
      narrationTextProcessing: "excluded",
      speechCharacters: { burst: 50_000, perDay: 100_000 },
    },
  },
  paid: {
    maxSubscriptions: 1000,
    maxIngestAddresses: 5,
    serverKeyModels: null,
    serverKeyRouting: "fastest",
    quotas: {
      pageFetches: { burst: 200, perDay: 2000 },
      fileConversions: { burst: 50, perDay: 100 },
      summaries: { burst: 100, perDay: 200 },
      narrationTextProcessing: { burst: 50, perDay: 200 },
      // Cloud voices run on our own speech server, which costs us almost
      // nothing: paid listening isn't capped.
      speechCharacters: null,
    },
  },
  unlimited: {
    maxSubscriptions: null,
    maxIngestAddresses: null,
    serverKeyModels: null,
    serverKeyRouting: "fastest",
    quotas: {
      pageFetches: null,
      fileConversions: null,
      summaries: null,
      narrationTextProcessing: null,
      speechCharacters: null,
    },
  },
};

export function isPlanId(value: string): value is PlanId {
  return (PLAN_IDS as readonly string[]).includes(value);
}
