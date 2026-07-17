import { describe, it, expect, afterEach } from "vitest";
import {
  getAvailableProviders,
  isChatModelId,
  isProviderAvailable,
} from "@/server/services/ai-providers";
import { getNarrationModelRef } from "@/server/services/narration";
import { getSummarizationModelId } from "@/server/services/summarization";
import {
  DEFAULT_SUMMARIZATION_MODELS,
  SUMMARIZATION_PROVIDER_PRIORITY,
} from "@/lib/summarization/constants";
import { DEFAULT_NARRATION_MODEL } from "@/lib/narration/constants";

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

  it("defaults to the first configured provider by priority", () => {
    clearEnv();
    expect(getSummarizationModelId(null, { groqApiKey: "g", cerebrasApiKey: "c" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.groq
    );
    expect(getSummarizationModelId(null, { anthropicApiKey: "a", cerebrasApiKey: "c" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.anthropic
    );
    expect(getSummarizationModelId(null, { cerebrasApiKey: "c" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.cerebras
    );
  });

  it("defaults to the Anthropic model when nothing is configured", () => {
    clearEnv();
    expect(getSummarizationModelId(null, {})).toBe(
      DEFAULT_SUMMARIZATION_MODELS[SUMMARIZATION_PROVIDER_PRIORITY[0]]
    );
  });
});

describe("getNarrationModelRef", () => {
  it("defaults to the built-in narration model", () => {
    clearEnv();
    expect(getNarrationModelRef(null)).toEqual({
      provider: "groq",
      model: "openai/gpt-oss-20b",
    });
  });

  it("uses the user model when set", () => {
    clearEnv();
    expect(getNarrationModelRef("cerebras:gpt-oss-120b")).toEqual({
      provider: "cerebras",
      model: "gpt-oss-120b",
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

describe("isChatModelId", () => {
  it("filters audio and moderation models", () => {
    expect(isChatModelId("whisper-large-v3")).toBe(false);
    expect(isChatModelId("distil-whisper-large-v3-en")).toBe(false);
    expect(isChatModelId("playai-tts")).toBe(false);
    expect(isChatModelId("meta-llama/llama-guard-4-12b")).toBe(false);
  });

  it("keeps chat models", () => {
    expect(isChatModelId("openai/gpt-oss-20b")).toBe(true);
    expect(isChatModelId("llama-3.3-70b-versatile")).toBe(true);
    expect(isChatModelId("qwen-3-32b")).toBe(true);
  });
});
