/**
 * Unit tests for the server-side session cookie helper (issue #1088).
 *
 * These are the sole writer of the browser `session` cookie. The security
 * contract: the cookie is always `HttpOnly` (token never reachable by JS),
 * `Secure` in production only (so it's never dropped on a plain-HTTP dev origin),
 * `SameSite=Lax`, `Path=/`; and there is NO second (readable) cookie. The clear
 * variant must match those attributes so the browser actually removes it.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { setSessionCookie, clearSessionCookie } from "@/server/auth/session-cookie";

/** Collect the Set-Cookie header(s) appended to a fresh Headers object. */
function capture(fn: (h: Headers) => void): string[] {
  const headers = new Headers();
  fn(headers);
  return headers.getSetCookie();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("server session cookie", () => {
  it("sets exactly one httpOnly session cookie (no readable marker)", () => {
    const cookies = capture((h) => setSessionCookie(h, "tok-123"));
    expect(cookies).toHaveLength(1);
    const [cookie] = cookies;
    expect(cookie).toContain("session=tok-123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=2592000"); // 30 days
    // No companion/readable cookie is emitted.
    expect(cookie).not.toMatch(/logged_in/i);
  });

  it("omits Secure outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    const [cookie] = capture((h) => setSessionCookie(h, "tok"));
    expect(cookie).not.toContain("Secure");
  });

  it("adds Secure in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const [cookie] = capture((h) => setSessionCookie(h, "tok"));
    expect(cookie).toContain("Secure");
  });

  it("clears with matching attributes and Max-Age=0", () => {
    vi.stubEnv("NODE_ENV", "production");
    const cookies = capture((h) => clearSessionCookie(h));
    expect(cookies).toHaveLength(1);
    const [cookie] = cookies;
    expect(cookie).toMatch(/^session=;/);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });

  it("no-ops when resHeaders is absent (REST/OpenAPI path)", () => {
    // Must not throw; there is simply nothing to write.
    expect(() => setSessionCookie(undefined, "tok")).not.toThrow();
    expect(() => clearSessionCookie(undefined)).not.toThrow();
  });
});
