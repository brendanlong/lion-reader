/**
 * Unit tests for the job exception-retry backoff.
 *
 * When a job handler throws (as opposed to returning a failure result with its
 * own nextRunAt), the worker schedules the retry with exponential backoff based
 * on the job's consecutive failure count, instead of a flat delay forever.
 */

import { describe, it, expect } from "vitest";
import {
  calculateExceptionRetryDelayMs,
  EXCEPTION_RETRY_BASE_MS,
  EXCEPTION_RETRY_MAX_MS,
} from "../../src/server/jobs/queue";

describe("calculateExceptionRetryDelayMs", () => {
  it("retries after the base delay on the first exception", () => {
    expect(calculateExceptionRetryDelayMs(0)).toBe(EXCEPTION_RETRY_BASE_MS);
  });

  it("doubles the delay per consecutive failure", () => {
    for (let failures = 1; failures <= 5; failures++) {
      expect(calculateExceptionRetryDelayMs(failures)).toBe(
        EXCEPTION_RETRY_BASE_MS * 2 ** failures
      );
    }
  });

  it("caps the delay", () => {
    let previous = EXCEPTION_RETRY_BASE_MS;
    for (let failures = 1; failures <= 100; failures++) {
      const delay = calculateExceptionRetryDelayMs(failures);
      expect(delay).toBe(Math.min(previous * 2, EXCEPTION_RETRY_MAX_MS));
      previous = delay;
    }
    expect(calculateExceptionRetryDelayMs(100)).toBe(EXCEPTION_RETRY_MAX_MS);
    expect(calculateExceptionRetryDelayMs(Number.MAX_SAFE_INTEGER)).toBe(EXCEPTION_RETRY_MAX_MS);
  });

  it("treats negative counts as zero", () => {
    expect(calculateExceptionRetryDelayMs(-1)).toBe(EXCEPTION_RETRY_BASE_MS);
  });
});
