import { describe, it, expect } from "vitest";
import { parseRetryAfter } from "../../src/server/http/retry-after";

describe("parseRetryAfter", () => {
  it("reads seconds or a date", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6);
  });

  it("rounds a partial second up and a past date to 0", () => {
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 8_500)).toBe(2);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 20_000)).toBe(0);
  });

  it.each([null, "", "soon"])("returns null for %j", (header) => {
    expect(parseRetryAfter(header)).toBeNull();
  });
});
