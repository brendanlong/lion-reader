import { describe, it, expect } from "vitest";
import { generateSummary } from "@/server/html/summary";

describe("generateSummary", () => {
  // Untrusted input; both shapes were quadratic (seconds per entry).
  it.each([
    [
      "one long paragraph near the footer pattern",
      `<p>The post ${" appeared first on x".repeat(40_000)}</p>`,
    ],
    [
      "nested empty fractions in a heading",
      `<h1><math>${"<mfrac>".repeat(10_000)}<mi></mi>${"</mfrac>".repeat(10_000)}</math></h1>`,
    ],
  ])("stays fast on %s", (_, html) => {
    const start = performance.now();
    generateSummary(html);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
