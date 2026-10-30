/** Wall-clock budgets for the content cleaner on hostile markup. */

import { describe, it, expect } from "vitest";
import { cleanContent, extractBaseHref } from "@/server/feed/content-cleaner";

describe("cleanContent", () => {
  it("should reject pathologically nested HTML quickly (CPU-exhaustion guard)", () => {
    // Extraction cost grows super-linearly with DOM nesting depth, and this
    // runs on attacker-controlled feed HTML — the native module caps depth
    // at 512 and fails fast to the raw-content fallback. Unguarded, this
    // input takes minutes; guarded it returns null in tens of milliseconds.
    const bomb = "<div>".repeat(5000) + "some text content here" + "</div>".repeat(5000);
    const start = performance.now();
    const result = cleanContent(bomb);
    expect(result).toBeNull();
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

describe("extractBaseHref", () => {
  it("stays linear on repeated unclosed <base fragments", () => {
    // `[^>]*` here took ~1.5s on this 120 KB input (quadratic).
    const hostile = "<base ".repeat(20000) + '><base href="/real/">';
    const started = performance.now();
    expect(extractBaseHref(hostile, "https://example.com")).toBe("https://example.com/real/");
    expect(performance.now() - started).toBeLessThan(200);
  });
});
