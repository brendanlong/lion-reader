import { describe, it, expect } from "vitest";
import { DEFAULT_JOB_TIMEOUT_MS, STALE_JOB_THRESHOLD_MS } from "../../src/server/jobs/queue";

describe("job queue timeouts", () => {
  it("only reclaims a job well after the worker gives up on it", () => {
    expect(DEFAULT_JOB_TIMEOUT_MS * 2).toBeLessThanOrEqual(STALE_JOB_THRESHOLD_MS);
  });
});
