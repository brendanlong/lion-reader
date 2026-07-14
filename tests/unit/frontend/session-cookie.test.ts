/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for the client-side session cookie helper.
 *
 * The security-relevant behaviour is the `Secure` attribute: it must be present
 * on HTTPS origins (so the JS-accessible 30-day token is never sent over cleartext
 * HTTP) and absent on plain-HTTP origins (where the browser would silently drop a
 * Secure cookie, breaking local dev). Reading `document.cookie` never returns
 * attributes, so we spy on the setter to capture the written cookie string.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setSessionCookie, clearSessionCookie, hasSessionCookie } from "@/lib/session-cookie";

/** Capture every `document.cookie = ...` write while still applying it to jsdom. */
function spyOnCookieWrites(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const original = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get() {
      return original.get!.call(document);
    },
    set(value: string) {
      writes.push(value);
      original.set!.call(document, value);
    },
  });
  return {
    writes,
    restore: () => {
      // Drop the instance override so the prototype accessor is used again.
      delete (document as unknown as { cookie?: unknown }).cookie;
    },
  };
}

function setProtocol(protocol: "http:" | "https:"): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, protocol },
  });
}

describe("session-cookie", () => {
  beforeEach(() => {
    // Clear any cookies left by a previous test.
    for (const c of document.cookie.split(";")) {
      const name = c.split("=")[0]?.trim();
      if (name) document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips: set then read then clear", () => {
    expect(hasSessionCookie()).toBe(false);
    setSessionCookie("token-abc");
    expect(hasSessionCookie()).toBe(true);
    expect(document.cookie).toContain("session=token-abc");
    clearSessionCookie();
    expect(hasSessionCookie()).toBe(false);
  });

  it("omits Secure on plain-HTTP origins (dev)", () => {
    setProtocol("http:");
    const cookie = spyOnCookieWrites();
    try {
      setSessionCookie("token-http");
      clearSessionCookie();
      expect(cookie.writes).toHaveLength(2);
      for (const write of cookie.writes) {
        expect(write.toLowerCase()).not.toContain("secure");
      }
    } finally {
      cookie.restore();
    }
  });

  it("adds Secure on HTTPS origins (production)", () => {
    setProtocol("https:");
    const cookie = spyOnCookieWrites();
    try {
      setSessionCookie("token-https");
      clearSessionCookie();
      expect(cookie.writes).toHaveLength(2);
      for (const write of cookie.writes) {
        expect(write).toContain("secure");
      }
      // Both writes keep SameSite=Lax and the correct name.
      expect(cookie.writes[0]).toContain("session=token-https");
      expect(cookie.writes[0]).toContain("samesite=lax");
    } finally {
      cookie.restore();
    }
  });
});
