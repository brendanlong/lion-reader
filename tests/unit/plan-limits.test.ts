/**
 * Relationships plan limits must keep, whatever the numbers: moving up a plan
 * never lowers a limit.
 */

import { describe, it, expect } from "vitest";
import { PLAN_LIMITS, PLAN_QUOTAS, type PlanId, type QuotaLimit } from "@/lib/plans";

/** A quota as a comparable size: excluded below any rate, no limit above. */
function size(limit: QuotaLimit): { burst: number; perDay: number } {
  if (limit === "excluded") return { burst: -1, perDay: -1 };
  if (limit === null) return { burst: Infinity, perDay: Infinity };
  return limit;
}

describe("plan limits", () => {
  it.each<[PlanId, PlanId]>([
    ["free", "paid"],
    ["paid", "unlimited"],
  ])("gives %s no quota above %s's", (lower, higher) => {
    for (const quota of PLAN_QUOTAS) {
      const low = size(PLAN_LIMITS[lower].quotas[quota]);
      const high = size(PLAN_LIMITS[higher].quotas[quota]);
      expect(high.burst, `${quota} burst`).toBeGreaterThanOrEqual(low.burst);
      expect(high.perDay, `${quota} per day`).toBeGreaterThanOrEqual(low.perDay);
    }
    if (PLAN_LIMITS[lower].backgroundFullContent) {
      expect(PLAN_LIMITS[higher].backgroundFullContent).toBe(true);
    }
  });
});
