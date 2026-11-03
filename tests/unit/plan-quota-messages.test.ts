/**
 * How plan quota errors read: a wait in hours and minutes, and quota names
 * lower-cased mid-sentence without breaking acronyms.
 */

import { describe, it, expect } from "vitest";
import { formatWait } from "@/lib/format";
import { PLAN_QUOTA_NAMES, quotaNameInSentence } from "@/lib/plans";

describe("formatWait", () => {
  it.each([
    [1, "1 minute"],
    [60, "1 minute"],
    [61, "2 minutes"],
    [59 * 60, "59 minutes"],
    [60 * 60, "1 hour"],
    [288 * 60, "4 hours and 48 minutes"],
    [25 * 60 * 60, "1 day and 1 hour"],
    [48 * 60 * 60, "2 days"],
  ])("says %i seconds as %s", (seconds, words) => {
    expect(formatWait(seconds)).toBe(words);
  });
});

describe("quotaNameInSentence", () => {
  it("lower-cases a name but keeps an acronym's capitals", () => {
    expect(quotaNameInSentence("pageFetches")).toBe(PLAN_QUOTA_NAMES.pageFetches.toLowerCase());
    expect(quotaNameInSentence("summaries")).toBe(PLAN_QUOTA_NAMES.summaries);
    expect(PLAN_QUOTA_NAMES.summaries).toMatch(/^AI /);
  });
});
