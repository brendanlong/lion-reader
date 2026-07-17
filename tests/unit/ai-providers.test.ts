import { describe, it, expect, afterEach } from "vitest";
import {
  filterToLatestClaudeGeneration,
  getAvailableProviders,
  isChatModelId,
  isProviderAvailable,
  supportsReasoningEffort,
} from "@/server/services/ai-providers";
import { getNarrationModelRef } from "@/server/services/narration";
import { getSummarizationModelId } from "@/server/services/summarization";
import {
  DEFAULT_SUMMARIZATION_MODELS,
  SUMMARIZATION_PROVIDER_PRIORITY,
} from "@/lib/summarization/constants";
import { DEFAULT_NARRATION_MODEL, DEFAULT_NARRATION_MODELS } from "@/lib/narration/constants";

const ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "SUMMARIZATION_MODEL",
  "NARRATION_MODEL",
] as const;

const originalEnv = Object.fromEntries(ENV_VARS.map((name) => [name, process.env[name]]));

function clearEnv() {
  for (const name of ENV_VARS) {
    delete process.env[name];
  }
}

afterEach(() => {
  for (const name of ENV_VARS) {
    const value = originalEnv[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("isProviderAvailable / getAvailableProviders", () => {
  it("uses per-user keys", () => {
    clearEnv();
    expect(isProviderAvailable("cerebras", { cerebrasApiKey: "csk-test" })).toBe(true);
    expect(isProviderAvailable("groq", { cerebrasApiKey: "csk-test" })).toBe(false);
    expect(getAvailableProviders({ groqApiKey: "gsk-test", anthropicApiKey: "sk-test" })).toEqual([
      "anthropic",
      "groq",
    ]);
  });

  it("falls back to server env keys", () => {
    clearEnv();
    process.env.GROQ_API_KEY = "gsk-server";
    expect(isProviderAvailable("groq")).toBe(true);
    expect(getAvailableProviders({})).toEqual(["groq"]);
  });

  it("reports nothing available with no keys at all", () => {
    clearEnv();
    expect(getAvailableProviders({})).toEqual([]);
  });
});

describe("getSummarizationModelId", () => {
  it("prefers the user model", () => {
    clearEnv();
    process.env.SUMMARIZATION_MODEL = "groq:foo";
    expect(getSummarizationModelId("cerebras:bar", {})).toBe("cerebras:bar");
  });

  it("falls back to the env var", () => {
    clearEnv();
    process.env.SUMMARIZATION_MODEL = "groq:foo";
    expect(getSummarizationModelId(null, {})).toBe("groq:foo");
  });

  it("defaults to the first configured provider by priority (Cerebras > Groq > Anthropic)", () => {
    clearEnv();
    // Cerebras wins over both others when configured.
    expect(getSummarizationModelId(null, { groqApiKey: "g", cerebrasApiKey: "c" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.cerebras
    );
    expect(getSummarizationModelId(null, { anthropicApiKey: "a", cerebrasApiKey: "c" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.cerebras
    );
    // Groq wins over Anthropic.
    expect(getSummarizationModelId(null, { anthropicApiKey: "a", groqApiKey: "g" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.groq
    );
    // Anthropic only when it's the sole option.
    expect(getSummarizationModelId(null, { anthropicApiKey: "a" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.anthropic
    );
  });

  it("defaults to the first-priority provider (Cerebras) when nothing is configured", () => {
    clearEnv();
    expect(SUMMARIZATION_PROVIDER_PRIORITY[0]).toBe("cerebras");
    expect(getSummarizationModelId(null, {})).toBe(
      DEFAULT_SUMMARIZATION_MODELS[SUMMARIZATION_PROVIDER_PRIORITY[0]]
    );
  });
});

describe("getNarrationModelRef", () => {
  it("defaults to the Cerebras gpt-oss-120b model when nothing is configured", () => {
    clearEnv();
    expect(getNarrationModelRef(null)).toEqual({
      provider: "cerebras",
      model: "gpt-oss-120b",
    });
  });

  it("defaults to the first configured provider (Cerebras before Groq)", () => {
    clearEnv();
    // Only Groq configured → Groq default.
    expect(getNarrationModelRef(null, { groqApiKey: "g" })).toEqual({
      provider: "groq",
      model: "openai/gpt-oss-120b",
    });
    expect(DEFAULT_NARRATION_MODELS.groq).toBe("groq:openai/gpt-oss-120b");
    // Both configured → Cerebras wins (fastest, listed first).
    expect(getNarrationModelRef(null, { groqApiKey: "g", cerebrasApiKey: "c" })).toEqual({
      provider: "cerebras",
      model: "gpt-oss-120b",
    });
    expect(DEFAULT_NARRATION_MODELS.cerebras).toBe("cerebras:gpt-oss-120b");
  });

  it("uses the user model when set", () => {
    clearEnv();
    expect(getNarrationModelRef("groq:openai/gpt-oss-20b")).toEqual({
      provider: "groq",
      model: "openai/gpt-oss-20b",
    });
  });

  it("uses the env var when the user model is unset", () => {
    clearEnv();
    process.env.NARRATION_MODEL = "cerebras:llama-3.3-70b";
    expect(getNarrationModelRef(null)).toEqual({
      provider: "cerebras",
      model: "llama-3.3-70b",
    });
  });

  it("falls back to the default for non-OpenAI-compatible references", () => {
    clearEnv();
    // Anthropic models can't do JSON-object responses, and a legacy bare ID
    // parses as Anthropic — both must fall back to the default model.
    expect(getNarrationModelRef("anthropic:claude-sonnet-5")).toEqual(
      getNarrationModelRef(DEFAULT_NARRATION_MODEL)
    );
    expect(getNarrationModelRef("some-bare-model")).toEqual(
      getNarrationModelRef(DEFAULT_NARRATION_MODEL)
    );
  });
});

describe("supportsReasoningEffort", () => {
  it("allows reasoning effort only for the gpt-oss family", () => {
    expect(supportsReasoningEffort("openai/gpt-oss-20b")).toBe(true);
    expect(supportsReasoningEffort("gpt-oss-120b")).toBe(true);
    // Groq/Cerebras 400 on reasoning_effort for non-reasoning models
    expect(supportsReasoningEffort("meta-llama/llama-4-scout-17b-16e-instruct")).toBe(false);
    expect(supportsReasoningEffort("llama-3.3-70b-versatile")).toBe(false);
    expect(supportsReasoningEffort("qwen-3-32b")).toBe(false);
  });
});

describe("isChatModelId", () => {
  it("filters audio and moderation models", () => {
    expect(isChatModelId("whisper-large-v3")).toBe(false);
    expect(isChatModelId("distil-whisper-large-v3-en")).toBe(false);
    expect(isChatModelId("playai-tts")).toBe(false);
    expect(isChatModelId("meta-llama/llama-guard-4-12b")).toBe(false);
  });

  it("filters TTS families that don't spell out 'tts'", () => {
    // Groq exposes Orpheus TTS under the canopylabs org.
    expect(isChatModelId("canopylabs/orpheus-3b-0.1-ft")).toBe(false);
    expect(isChatModelId("orpheus-3b")).toBe(false);
  });

  it("keeps chat models", () => {
    expect(isChatModelId("openai/gpt-oss-20b")).toBe(true);
    expect(isChatModelId("llama-3.3-70b-versatile")).toBe(true);
    expect(isChatModelId("qwen-3-32b")).toBe(true);
  });
});

describe("filterToLatestClaudeGeneration", () => {
  it("keeps only the newest model per family (API returns newest-first)", () => {
    const models = [
      { id: "claude-opus-4-8", displayName: "Claude Opus 4.8" },
      { id: "claude-opus-4-7", displayName: "Claude Opus 4.7" },
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
      { id: "claude-3-5-haiku", displayName: "Claude Haiku 3.5" },
      { id: "claude-fable-5", displayName: "Claude Fable 5" },
    ];
    expect(filterToLatestClaudeGeneration(models).map((m) => m.id)).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-fable-5",
    ]);
  });

  it("keeps models that don't match a known family", () => {
    const models = [{ id: "claude-some-new-family-1", displayName: "New" }];
    expect(filterToLatestClaudeGeneration(models).map((m) => m.id)).toEqual([
      "claude-some-new-family-1",
    ]);
  });
});
