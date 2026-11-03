/**
 * Quota names in plan quota errors: lower-cased mid-sentence without breaking
 * acronyms.
 */

import { describe, it, expect } from "vitest";
import { PLAN_QUOTA_NAMES, quotaNameInSentence } from "@/lib/plans";

describe("quotaNameInSentence", () => {
  it("lower-cases a name but keeps an acronym's capitals", () => {
    expect(quotaNameInSentence("pageFetches")).toBe(PLAN_QUOTA_NAMES.pageFetches.toLowerCase());
    expect(quotaNameInSentence("summaries")).toBe(PLAN_QUOTA_NAMES.summaries);
    expect(PLAN_QUOTA_NAMES.summaries).toMatch(/^AI /);
  });
});
