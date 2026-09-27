import { describe, it, expect } from "vitest";
import {
  buildModelPickerSections,
  formatModelDetails,
  matchesModelQuery,
  type PickerModel,
} from "@/lib/ai/model-picker";

const models: PickerModel[] = [
  { id: "anthropic:claude-sonnet-5", displayName: "Claude Sonnet 5", provider: "anthropic" },
  { id: "cerebras:gpt-oss-120b", displayName: "gpt-oss-120b", provider: "cerebras" },
  {
    id: "openrouter:openai/gpt-oss-120b",
    displayName: "OpenAI: gpt-oss-120b",
    provider: "openrouter",
    contextLength: 131072,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.6,
  },
  {
    id: "openrouter:google/gemini-3.8-flash",
    displayName: "Google: Gemini 3.8 Flash",
    provider: "openrouter",
    contextLength: 1048576,
    inputPricePerMillion: 0.75,
    outputPricePerMillion: 3.75,
  },
];

const labels = (sections: ReturnType<typeof buildModelPickerSections>) =>
  sections.map((section) => [section.label, section.models.map((model) => model.id)]);

describe("buildModelPickerSections", () => {
  it("leads with the default then available suggestions, without repeating them below", () => {
    const sections = buildModelPickerSections(models, {
      query: "",
      defaultModelId: "cerebras:gpt-oss-120b",
      suggestedModelIds: [
        "openrouter:google/gemini-3.8-flash",
        "cerebras:gpt-oss-120b",
        "groq:openai/gpt-oss-120b", // provider not configured → not listed
      ],
    });
    expect(labels(sections)).toEqual([
      ["Suggested", ["cerebras:gpt-oss-120b", "openrouter:google/gemini-3.8-flash"]],
      ["Anthropic", ["anthropic:claude-sonnet-5"]],
      ["OpenRouter", ["openrouter:openai/gpt-oss-120b"]],
    ]);
  });

  it("groups search matches by provider, suggestions included", () => {
    const sections = buildModelPickerSections(models, {
      query: "gpt oss",
      defaultModelId: "cerebras:gpt-oss-120b",
      suggestedModelIds: [],
    });
    expect(labels(sections)).toEqual([
      ["Cerebras", ["cerebras:gpt-oss-120b"]],
      ["OpenRouter", ["openrouter:openai/gpt-oss-120b"]],
    ]);
  });
});

describe("matchesModelQuery", () => {
  it("requires every term, matching name, ID, or provider case-insensitively", () => {
    const [, , gptOss, gemini] = models;
    expect(matchesModelQuery(gemini, "GEMINI flash")).toBe(true);
    expect(matchesModelQuery(gemini, "google/gemini")).toBe(true);
    expect(matchesModelQuery(gptOss, "openrouter 120b")).toBe(true);
    expect(matchesModelQuery(gemini, "gemini pro")).toBe(false);
  });
});

describe("formatModelDetails", () => {
  it("shows provider, context, and prices when known", () => {
    expect(formatModelDetails(models[2])).toBe(
      "OpenRouter · 131K context · $0.15 in / $0.60 out per 1M tokens"
    );
    expect(formatModelDetails(models[3])).toBe(
      "OpenRouter · 1M context · $0.75 in / $3.75 out per 1M tokens"
    );
    expect(
      formatModelDetails({ ...models[2], inputPricePerMillion: 0.018, outputPricePerMillion: 0 })
    ).toBe("OpenRouter · 131K context · $0.018 in / free out per 1M tokens");
    expect(
      formatModelDetails({ ...models[2], inputPricePerMillion: 0, outputPricePerMillion: 0 })
    ).toBe("OpenRouter · 131K context · free");
  });

  it("shows only the provider when nothing else is reported", () => {
    expect(formatModelDetails(models[0])).toBe("Anthropic");
  });
});
