/** Wall-clock budget for Threads title parsing (ReDoS guard). */

import { describe, it, expect } from "vitest";
import { parseThreadsAuthor } from "@/server/plugins/threads";

describe("parseThreadsAuthor", () => {
  it("stays linear on a long whitespace run", () => {
    // An unanchored leading `\s+` rescanned the run from each position: ~1s.
    const started = performance.now();
    expect(parseThreadsAuthor(`a${" ".repeat(40000)}b`)).toBe(`a${" ".repeat(40000)}b`);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
