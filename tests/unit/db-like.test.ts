import { describe, expect, it } from "vitest";
import { containsPattern } from "@/server/db/like";

describe("containsPattern", () => {
  it("escapes a backslash, so it can't escape the wildcard after it or our own escapes", () => {
    // Unescaped, a trailing `\` would escape the closing `%`, and `\%` would
    // reach Postgres as an escaped `%` rather than a backslash then a literal `%`.
    expect(containsPattern("C:\\")).toBe("%C:\\\\%");
    expect(containsPattern("\\%")).toBe("%\\\\\\%%");
  });
});
