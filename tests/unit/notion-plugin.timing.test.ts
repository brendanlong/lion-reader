/** Wall-clock budget for Notion shell detection (ReDoS guard). */

import { describe, it, expect } from "vitest";
import { isNotionShell } from "../../src/server/plugins/notion";

describe("isNotionShell", () => {
  it("stays linear on a document made of repeated <html fragments", () => {
    const hostile = "<html".repeat(13000);
    const started = performance.now();
    expect(isNotionShell(hostile)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
