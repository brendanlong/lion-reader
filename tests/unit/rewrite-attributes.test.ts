/**
 * The N-API binding of `rewriteAttributes`; the rewriting itself is tested in
 * `native/sanitizer/core/src/attributes.rs`, and `absolutizeUrls` in
 * `content-cleaner.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { rewriteAttributes } from "@lion-reader/sanitizer";

describe("rewriteAttributes", () => {
  it("rethrows the callback's own error and keeps working after", () => {
    const error = new Error("boom");
    expect(() =>
      rewriteAttributes('<a href="x">', ["href"], () => {
        throw error;
      })
    ).toThrow(error);
    expect(rewriteAttributes('<a href="x">', ["href"], () => "y")).toBe('<a href="y">');
  });

  it("rejects a callback result that isn't a string, null or undefined", () => {
    expect(() => rewriteAttributes('<a href="x">', ["href"], () => 5 as unknown as string)).toThrow(
      /must return a string/
    );
  });
});
