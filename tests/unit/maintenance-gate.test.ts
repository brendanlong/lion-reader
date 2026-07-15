/**
 * Unit tests for the maintenance gate's pure request-evaluation logic and the
 * self-contained maintenance responses (custom-server hot path).
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  evaluateRequest,
  renderMaintenanceHtml,
  maintenanceJsonBody,
} from "../../src/server/maintenance/server-gate";
import { createAdminSessionToken, ADMIN_COOKIE_NAME } from "../../src/server/auth/admin-session";

describe("evaluateRequest", () => {
  it("allows the demo, admin, health, legal, and root surfaces", () => {
    for (const path of [
      "/",
      "/demo",
      "/demo/all",
      "/admin",
      "/admin/status",
      "/api/admin/session",
      "/api/health",
      "/privacy",
      "/terms",
    ]) {
      expect(evaluateRequest(path)).toBe("allow");
    }
  });

  it("allows Next internals and static assets", () => {
    for (const path of [
      "/_next/static/chunk.js",
      "/favicon.ico",
      "/robots.txt",
      "/sitemap.xml",
      "/sw.js",
      "/icons/icon-192.png",
      "/apple-touch-icon.png",
      "/some/thing.css",
    ]) {
      expect(evaluateRequest(path)).toBe("allow");
    }
  });

  it("blocks app pages with the HTML page response", () => {
    for (const path of ["/all", "/login", "/save", "/complete-signup", "/settings"]) {
      expect(evaluateRequest(path)).toBe("block-page");
    }
  });

  it("blocks non-admin API routes with the JSON response", () => {
    for (const path of [
      "/api/v1/entries",
      "/api/mcp",
      "/api/wallabag/api/entries",
      "/api/greader.php",
    ]) {
      expect(evaluateRequest(path)).toBe("block-api");
    }
  });

  it("blocks API routes even when they end in a static-looking suffix", () => {
    // The Wallabag compat API and others hit Postgres but end in .json/.xml/etc.
    // These must NOT be treated as static assets during maintenance.
    for (const path of [
      "/api/wallabag/api/entries.json",
      "/api/wallabag/api/tags.json",
      "/api/wallabag/api/user.json",
      "/api/entries.json",
      "/api/search.json",
      "/api/version.json",
    ]) {
      expect(evaluateRequest(path)).toBe("block-api");
    }
  });

  it("does not treat a page path that merely contains /demo as exempt", () => {
    expect(evaluateRequest("/not-demo")).toBe("block-page");
    expect(evaluateRequest("/admins")).toBe("block-page");
  });

  describe("/api/trpc admin exception", () => {
    beforeAll(() => {
      process.env.ADMIN_SECRET = "test-admin-secret-for-gate";
    });

    it("blocks /api/trpc without a cookie", () => {
      expect(evaluateRequest("/api/trpc/admin.getSiteStatus")).toBe("block-api");
    });

    it("blocks /api/trpc with an invalid admin cookie", () => {
      expect(evaluateRequest("/api/trpc/admin.getSiteStatus", `${ADMIN_COOKIE_NAME}=garbage`)).toBe(
        "block-api"
      );
    });

    it("allows /api/trpc with a valid admin session cookie", () => {
      const token = createAdminSessionToken();
      const cookie = `foo=bar; ${ADMIN_COOKIE_NAME}=${token}; other=1`;
      expect(evaluateRequest("/api/trpc/admin.getSiteStatus", cookie)).toBe("allow");
    });

    it("allows /api/trpc with a valid Bearer admin secret", () => {
      expect(
        evaluateRequest(
          "/api/trpc/admin.getSiteStatus",
          undefined,
          "Bearer test-admin-secret-for-gate"
        )
      ).toBe("allow");
    });

    it("blocks /api/trpc with an invalid Bearer secret", () => {
      expect(
        evaluateRequest("/api/trpc/admin.getSiteStatus", undefined, "Bearer wrong-secret")
      ).toBe("block-api");
    });

    it("tolerates extra whitespace / tab between Bearer and the secret", () => {
      for (const auth of [
        "Bearer   test-admin-secret-for-gate",
        "Bearer\ttest-admin-secret-for-gate",
        "bearer test-admin-secret-for-gate  ",
      ]) {
        expect(evaluateRequest("/api/trpc/admin.getSiteStatus", undefined, auth)).toBe("allow");
      }
    });

    it("resolves a crafted whitespace-heavy Authorization header quickly (no ReDoS)", () => {
      const evil = `Bearer ${" ".repeat(100_000)}\n`;
      const start = Date.now();
      expect(evaluateRequest("/api/trpc/admin.getSiteStatus", undefined, evil)).toBe("block-api");
      expect(Date.now() - start).toBeLessThan(100);
    });
  });
});

describe("renderMaintenanceHtml", () => {
  it("includes the message and escapes HTML", () => {
    const html = renderMaintenanceHtml('<script>alert("x")</script> & more');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; more");
    expect(html).not.toContain("<script>alert");
  });

  it("falls back to a default message when empty", () => {
    const html = renderMaintenanceHtml("   ");
    expect(html).toContain("maintenance");
    expect(html).toContain("<!doctype html>");
  });
});

describe("maintenanceJsonBody", () => {
  it("returns a JSON error body with the message", () => {
    const parsed = JSON.parse(maintenanceJsonBody("Down for DB migration"));
    expect(parsed.error).toBe("maintenance");
    expect(parsed.message).toBe("Down for DB migration");
  });

  it("uses the default message when none is provided", () => {
    const parsed = JSON.parse(maintenanceJsonBody());
    expect(parsed.error).toBe("maintenance");
    expect(typeof parsed.message).toBe("string");
    expect(parsed.message.length).toBeGreaterThan(0);
  });
});
