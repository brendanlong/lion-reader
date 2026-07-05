/**
 * Unit tests for client IP / client info extraction.
 *
 * The trusted precedence here is security-critical: it must ignore the
 * spoofable leftmost x-forwarded-for hop so rate-limiting and session logging
 * can't be fooled by a client-supplied value.
 */

import { describe, it, expect } from "vitest";
import { getClientIp, extractClientInfo } from "../../src/server/http/client-ip";

describe("getClientIp", () => {
  it("prefers the trustworthy Fly-Client-IP header over x-forwarded-for", () => {
    const headers = new Headers({
      "fly-client-ip": "9.9.9.9",
      // Spoofed leftmost hop must be ignored in favor of Fly-Client-IP.
      "x-forwarded-for": "1.2.3.4, 9.9.9.9",
      "x-real-ip": "5.6.7.8",
    });
    expect(getClientIp(headers)).toBe("9.9.9.9");
  });

  it("uses the rightmost (LB-appended) x-forwarded-for hop, not the spoofable first one", () => {
    // Fly appends the real client IP; a client-supplied leftmost value must not win.
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" });
    expect(getClientIp(headers)).toBe("203.0.113.7");
  });

  it("cannot be fooled by rotating a spoofed leftmost x-forwarded-for value", () => {
    const realClientHop = "203.0.113.7";
    const a = getClientIp(new Headers({ "x-forwarded-for": `1.1.1.1, ${realClientHop}` }));
    const b = getClientIp(new Headers({ "x-forwarded-for": `2.2.2.2, ${realClientHop}` }));
    // Different spoofed prefixes still resolve to the same real client IP.
    expect(a).toBe(b);
    expect(a).toBe(realClientHop);
  });

  it("handles a single-hop x-forwarded-for", () => {
    expect(getClientIp(new Headers({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip when no forwarded-for is present", () => {
    expect(getClientIp(new Headers({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("falls back to x-real-ip when x-forwarded-for is empty/whitespace", () => {
    const headers = new Headers({ "x-forwarded-for": " , ", "x-real-ip": "5.6.7.8" });
    expect(getClientIp(headers)).toBe("5.6.7.8");
  });

  it("returns undefined when no trusted IP header is present", () => {
    expect(getClientIp(new Headers())).toBeUndefined();
  });
});

describe("extractClientInfo", () => {
  it("bundles user agent with the trusted client IP", () => {
    const headers = new Headers({
      "user-agent": "test-agent/1.0",
      "x-forwarded-for": "1.2.3.4, 203.0.113.7",
    });
    expect(extractClientInfo(headers)).toEqual({
      userAgent: "test-agent/1.0",
      ipAddress: "203.0.113.7",
    });
  });

  it("uses undefined for missing user agent and IP", () => {
    expect(extractClientInfo(new Headers())).toEqual({
      userAgent: undefined,
      ipAddress: undefined,
    });
  });
});
