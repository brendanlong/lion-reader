/**
 * Wall-clock budgets for email header parsing (ReDoS guards).
 */

import { describe, it, expect } from "vitest";
import { parseFromAddress, parseListUnsubscribeUrl } from "@/server/email/parse-utils";

describe("parseFromAddress", () => {
  it.each([
    ["repeated <", "a" + "<".repeat(30000) + ">>"],
    ["repeated ' <'", "a <".repeat(10000) + ">>"],
    ["a long whitespace run", "a" + " ".repeat(30000) + "<x@example.com>x"],
  ])("stays linear on %s", (_case, hostile) => {
    // `^(.+?)\s*<([^>]+)>$` took ~0.3-0.7s on each of these (quadratic).
    const started = performance.now();
    parseFromAddress(hostile);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("parseListUnsubscribeUrl", () => {
  it("stays linear on repeated unclosed <mailto: fragments", () => {
    // `<(mailto:[^>]+)>` took ~0.3s here (quadratic).
    const started = performance.now();
    expect(parseListUnsubscribeUrl("<mailto:".repeat(8000), "mailto")).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
  });
});
