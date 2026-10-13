import { describe, it, expect } from "vitest";
import { isNewerBuild } from "@/lib/build-id";

describe("isNewerBuild", () => {
  it.each([
    ["2026-10-13T01:00:00Z", "2026-10-12T01:00:00Z", true],
    ["2026-10-12T01:00:00Z", "2026-10-13T01:00:00Z", false],
    ["2026-10-13T01:00:00Z", "2026-10-13T01:00:00Z", false],
    [undefined, "2026-10-13T01:00:00Z", false],
    ["", "2026-10-13T01:00:00Z", false],
    ["2026-10-13T01:00:00Z", "", false],
  ])("server %s, page %s: %s", (server, page, expected) => {
    expect(isNewerBuild(server, page)).toBe(expected);
  });
});
