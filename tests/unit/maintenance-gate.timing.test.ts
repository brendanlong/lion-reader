/** Wall-clock budget for the maintenance gate's Authorization parsing (ReDoS guard). */

import { describe, it, expect, beforeAll } from "vitest";
import { evaluateRequest } from "../../src/server/maintenance/server-gate";

describe("evaluateRequest", () => {
  beforeAll(() => {
    process.env.ADMIN_SECRET = "test-admin-secret-for-gate";
  });

  it("resolves a crafted whitespace-heavy Authorization header quickly (no ReDoS)", () => {
    const evil = `Bearer ${" ".repeat(100_000)}\n`;
    const start = Date.now();
    expect(evaluateRequest("/api/trpc/admin.getSiteStatus", undefined, evil)).toBe("block-api");
    expect(Date.now() - start).toBeLessThan(100);
  });
});
