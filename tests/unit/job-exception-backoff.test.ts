/**
 * Unit tests for the job exception-retry backoff.
 *
 * When a job handler throws (as opposed to returning a failure result with its
 * own nextRunAt), the worker schedules the retry with exponential backoff based
 * on the job's consecutive failure count, instead of a flat 60s forever.
 */

import { describe, it, expect } from "vitest";
import { calculateExceptionRetryDelayMs } from "../../src/server/jobs/queue";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

describe("calculateExceptionRetryDelayMs", () => {
  it("retries after 1 minute on the first exception", () => {
    expect(calculateExceptionRetryDelayMs(0)).toBe(MINUTE_MS);
  });

  it("doubles the delay per consecutive failure", () => {
    expect(calculateExceptionRetryDelayMs(1)).toBe(2 * MINUTE_MS);
    expect(calculateExceptionRetryDelayMs(2)).toBe(4 * MINUTE_MS);
    expect(calculateExceptionRetryDelayMs(5)).toBe(32 * MINUTE_MS);
    expect(calculateExceptionRetryDelayMs(9)).toBe(512 * MINUTE_MS); // ~8.5h
  });

  it("caps the delay at 24 hours", () => {
    expect(calculateExceptionRetryDelayMs(10)).toBe(1024 * MINUTE_MS); // ~17h, still under cap
    expect(calculateExceptionRetryDelayMs(11)).toBe(24 * HOUR_MS);
    expect(calculateExceptionRetryDelayMs(100)).toBe(24 * HOUR_MS);
    expect(calculateExceptionRetryDelayMs(Number.MAX_SAFE_INTEGER)).toBe(24 * HOUR_MS);
  });

  it("treats negative counts as zero", () => {
    expect(calculateExceptionRetryDelayMs(-1)).toBe(MINUTE_MS);
  });
});
