import { describe, it, expect } from "vitest";
import { simplifyModelIds } from "@/server/services/summarization";

describe("simplifyModelIds", () => {
  it("strips date suffixes from versioned model IDs", () => {
    const models = [
      { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" },
      { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5" },
    ];

    const result = simplifyModelIds(models);
    expect(result).toEqual([
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
    ]);
  });

  it("passes through models without date suffix unchanged", () => {
    const models = [{ id: "claude-opus-4-6", displayName: "Claude Opus 4.6" }];

    const result = simplifyModelIds(models);
    expect(result).toEqual([{ id: "claude-opus-4-6", displayName: "Claude Opus 4.6" }]);
  });

  it("deduplicates when alias and versioned ID both exist", () => {
    const models = [
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
      { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" },
    ];

    const result = simplifyModelIds(models);
    expect(result).toEqual([{ id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" }]);
  });

  it("keeps only the first version when multiple versions exist", () => {
    const models = [
      { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" },
      { id: "claude-sonnet-4-5-20250801", displayName: "Claude Sonnet 4.5 (old)" },
    ];

    const result = simplifyModelIds(models);
    expect(result).toEqual([{ id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" }]);
  });

  it("returns empty array for empty input", () => {
    expect(simplifyModelIds([])).toEqual([]);
  });
});
