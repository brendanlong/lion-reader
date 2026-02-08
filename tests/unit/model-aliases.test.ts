import { describe, it, expect } from "vitest";
import { addModelAliases } from "@/server/services/summarization";

describe("addModelAliases", () => {
  it("adds alias entries for models with date suffixes", () => {
    const models = [
      { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" },
      { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5" },
    ];

    const result = addModelAliases(models);
    expect(result).toEqual([
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5 (latest)" },
      { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" },
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5 (latest)" },
      { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5" },
    ]);
  });

  it("does not add alias for models without date suffix", () => {
    const models = [{ id: "claude-opus-4-6", displayName: "Claude Opus 4.6" }];

    const result = addModelAliases(models);
    expect(result).toEqual([{ id: "claude-opus-4-6", displayName: "Claude Opus 4.6" }]);
  });

  it("does not add duplicate alias when ID already exists", () => {
    const models = [
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
      { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" },
    ];

    const result = addModelAliases(models);
    expect(result).toEqual([
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
      { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" },
    ]);
  });

  it("only adds alias for the first versioned model when multiple versions exist", () => {
    const models = [
      { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" },
      { id: "claude-sonnet-4-5-20250801", displayName: "Claude Sonnet 4.5 (old)" },
    ];

    const result = addModelAliases(models);
    expect(result).toEqual([
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5 (latest)" },
      { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" },
      { id: "claude-sonnet-4-5-20250801", displayName: "Claude Sonnet 4.5 (old)" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(addModelAliases([])).toEqual([]);
  });
});
