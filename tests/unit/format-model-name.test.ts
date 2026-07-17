import { describe, it, expect } from "vitest";

import { formatModelName } from "@/lib/summarization/format-model-name";

describe("formatModelName", () => {
  it("title-cases the model name and joins version numbers with dots", () => {
    expect(formatModelName("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
    expect(formatModelName("claude-opus-4-8")).toBe("Claude Opus 4.8");
  });

  it("handles single-number versions", () => {
    expect(formatModelName("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(formatModelName("claude-haiku-4")).toBe("Claude Haiku 4");
  });

  it("strips a trailing date suffix", () => {
    expect(formatModelName("claude-sonnet-4-5-20250929")).toBe("Claude Sonnet 4.5");
    expect(formatModelName("claude-opus-4-1-20250805")).toBe("Claude Opus 4.1");
  });

  it("handles the older version-first naming shape", () => {
    expect(formatModelName("claude-3-5-sonnet")).toBe("Claude 3.5 Sonnet");
    expect(formatModelName("claude-3-7-sonnet-20250219")).toBe("Claude 3.7 Sonnet");
  });

  it("falls back to title-casing non-Claude IDs", () => {
    expect(formatModelName("llama-3-1-70b")).toBe("Llama 3.1 70B");
  });

  it("drops the provider prefix from provider-qualified refs", () => {
    expect(formatModelName("anthropic:claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(formatModelName("cerebras:gpt-oss-120b")).toBe("GPT-OSS 120B");
  });

  it("drops org prefixes in provider-native IDs", () => {
    expect(formatModelName("groq:openai/gpt-oss-20b")).toBe("GPT-OSS 20B");
    expect(formatModelName("groq:meta-llama/llama-4-scout-17b-16e-instruct")).toBe(
      "Llama 4 Scout 17B 16e Instruct"
    );
  });

  it("uppercases acronyms and parameter-count suffixes", () => {
    expect(formatModelName("groq:llama-3.3-70b-versatile")).toBe("Llama 3.3 70B Versatile");
    expect(formatModelName("cerebras:qwen-3-32b")).toBe("Qwen 3 32B");
  });

  it("returns empty string unchanged", () => {
    expect(formatModelName("")).toBe("");
  });
});
