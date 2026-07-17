import { describe, it, expect } from "vitest";
import { parseModelRef, formatModelRef } from "@/lib/ai/model-ref";

describe("parseModelRef", () => {
  it("parses provider-prefixed references", () => {
    expect(parseModelRef("anthropic:claude-sonnet-5")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(parseModelRef("cerebras:gpt-oss-120b")).toEqual({
      provider: "cerebras",
      model: "gpt-oss-120b",
    });
  });

  it("keeps slashes in the provider-native model ID", () => {
    expect(parseModelRef("groq:openai/gpt-oss-20b")).toEqual({
      provider: "groq",
      model: "openai/gpt-oss-20b",
    });
  });

  it("treats bare model IDs as Anthropic (legacy stored values)", () => {
    expect(parseModelRef("claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
  });

  it("treats unknown prefixes as part of a bare Anthropic model ID", () => {
    expect(parseModelRef("openai:gpt-4")).toEqual({
      provider: "anthropic",
      model: "openai:gpt-4",
    });
  });

  it("treats a leading colon as a bare model ID", () => {
    expect(parseModelRef(":claude-sonnet-5")).toEqual({
      provider: "anthropic",
      model: ":claude-sonnet-5",
    });
  });

  it("round-trips through formatModelRef", () => {
    const ref = parseModelRef("groq:openai/gpt-oss-20b");
    expect(formatModelRef(ref.provider, ref.model)).toBe("groq:openai/gpt-oss-20b");
  });
});
