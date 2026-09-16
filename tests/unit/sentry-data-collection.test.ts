/**
 * Unit tests for the Sentry data-collection policy.
 *
 * The value matters more than it looks: Sentry resolves `userInfo` to `false`
 * only while `dataCollection` is unset, and SDK v11 removes the bridge that
 * produces that. Both paths would start sending client IPs with no code change,
 * so this pins the posture rather than trusting a default.
 */

import { describe, it, expect } from "vitest";
import { SENTRY_DATA_COLLECTION } from "../../src/lib/sentry-data-collection";

describe("SENTRY_DATA_COLLECTION", () => {
  it("opts out of automatic user info, which is what carries the client IP", () => {
    expect(SENTRY_DATA_COLLECTION?.userInfo).toBe(false);
  });

  it("is set at all, so the option object reaches Sentry.init", () => {
    // An undefined value would silently fall back to the SDK default.
    expect(SENTRY_DATA_COLLECTION).toBeDefined();
  });
});
