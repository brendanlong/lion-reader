import { describe, it, expect } from "vitest";
import { safeRedirectPath } from "../../src/lib/safe-redirect";

describe("safeRedirectPath", () => {
  it("allows same-origin absolute paths", () => {
    expect(safeRedirectPath("/all")).toBe("/all");
    expect(safeRedirectPath("/settings?tab=account")).toBe("/settings?tab=account");
    expect(safeRedirectPath("/tag/123#top")).toBe("/tag/123#top");
  });

  it("falls back for empty/missing values", () => {
    expect(safeRedirectPath(null)).toBe("/all");
    expect(safeRedirectPath(undefined)).toBe("/all");
    expect(safeRedirectPath("")).toBe("/all");
    expect(safeRedirectPath(null, "/home")).toBe("/home");
  });

  it("rejects absolute URLs (open redirect)", () => {
    expect(safeRedirectPath("https://evil.com/phish")).toBe("/all");
    expect(safeRedirectPath("http://evil.com")).toBe("/all");
    expect(safeRedirectPath("HTTPS://evil.com")).toBe("/all");
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/all");
    expect(safeRedirectPath("mailto:a@b.com")).toBe("/all");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeRedirectPath("//evil.com")).toBe("/all");
    expect(safeRedirectPath("//evil.com/path")).toBe("/all");
    expect(safeRedirectPath("/\\evil.com")).toBe("/all");
    expect(safeRedirectPath("/\\/evil.com")).toBe("/all");
  });

  it("rejects values that don't start with a path separator", () => {
    expect(safeRedirectPath("all")).toBe("/all");
    expect(safeRedirectPath("evil.com")).toBe("/all");
    expect(safeRedirectPath("../etc/passwd")).toBe("/all");
  });

  it("rejects control-character tricks that the URL parser normalizes cross-origin", () => {
    // The URL parser strips tabs/newlines, turning "/\t/evil.com" into the
    // protocol-relative "//evil.com" (origin evil.com) — caught by the origin check.
    expect(safeRedirectPath("/\t/evil.com")).toBe("/all");
    expect(safeRedirectPath("/\n/evil.com")).toBe("/all");
  });
});
