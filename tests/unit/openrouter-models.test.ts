import { describe, it, expect } from "vitest";
import { isUsableOpenRouterModel, type OpenRouterModel } from "@/server/services/openrouter";

function model(overrides: Partial<OpenRouterModel> & { id: string }): OpenRouterModel {
  return {
    name: null,
    context_length: 131072,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["max_tokens", "response_format", "temperature"],
    ...overrides,
  };
}

describe("isUsableOpenRouterModel", () => {
  it("keeps ordinary long-context text models", () => {
    expect(isUsableOpenRouterModel(model({ id: "openai/gpt-oss-120b" }))).toBe(true);
  });

  it("drops models whose context is too short for an article", () => {
    expect(
      isUsableOpenRouterModel(model({ id: "google/gemma-2-9b-it", context_length: 8192 }))
    ).toBe(false);
  });

  it("keeps models whose context window the catalog omits", () => {
    expect(isUsableOpenRouterModel(model({ id: "some/new-model", context_length: null }))).toBe(
      true
    );
  });

  it("drops models that can't emit text", () => {
    expect(
      isUsableOpenRouterModel(
        model({
          id: "google/gemini-2.5-flash-image",
          architecture: { input_modalities: ["text"], output_modalities: ["image"] },
        })
      )
    ).toBe(false);
  });

  it("drops models that can't accept text", () => {
    expect(
      isUsableOpenRouterModel(
        model({
          id: "some/audio-only",
          architecture: { input_modalities: ["audio"], output_modalities: ["text"] },
        })
      )
    ).toBe(false);
  });

  it("keeps multimodal models as long as text goes in and out", () => {
    expect(
      isUsableOpenRouterModel(
        model({
          id: "anthropic/claude-opus-5",
          architecture: {
            input_modalities: ["text", "image", "file"],
            output_modalities: ["text"],
          },
        })
      )
    ).toBe(true);
  });

  it("drops audio and moderation models by ID", () => {
    expect(isUsableOpenRouterModel(model({ id: "openai/whisper-large-v3" }))).toBe(false);
    expect(isUsableOpenRouterModel(model({ id: "meta-llama/llama-guard-4-12b" }))).toBe(false);
  });

  it("keeps models without response_format unless JSON output is required", () => {
    const noJson = model({ id: "some/model", supported_parameters: ["max_tokens"] });
    expect(isUsableOpenRouterModel(noJson)).toBe(true);
    expect(isUsableOpenRouterModel(noJson, { requireJsonObject: true })).toBe(false);
  });

  it("requires response_format for narration", () => {
    expect(
      isUsableOpenRouterModel(model({ id: "openai/gpt-oss-120b" }), {
        requireJsonObject: true,
      })
    ).toBe(true);
  });

  it("is fail-closed about JSON support when the catalog reports no parameters", () => {
    // Summaries take any text, so an unreported parameter list is fine there;
    // narration parses JSON out of the response, so it needs an explicit yes.
    const unknown = model({ id: "some/new-model", supported_parameters: null });
    expect(isUsableOpenRouterModel(unknown)).toBe(true);
    expect(isUsableOpenRouterModel(unknown, { requireJsonObject: true })).toBe(false);
  });
});
