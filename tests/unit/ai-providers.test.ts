import { describe, it, expect, afterEach } from "vitest";
import {
  filterToLatestClaudeGeneration,
  getAvailableProviders,
  isChatModelId,
  isModelAllowed,
  isProviderAvailable,
  isUsableOpenRouterModel,
  supportsReasoningEffort,
} from "@/server/services/ai-providers";
import { getNarrationModelRef } from "@/server/services/narration";
import { parseModelRef } from "@/lib/ai/model-ref";
import { buildChatCompletionBody } from "@/server/services/openrouter";
import { getSummarizationModelId } from "@/server/services/summarization";
import {
  DEFAULT_SUMMARIZATION_MODELS,
  SUMMARIZATION_PROVIDER_PRIORITY,
} from "@/lib/summarization/constants";
import { DEFAULT_NARRATION_MODELS } from "@/lib/narration/constants";

const ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPINFRA_API_KEY",
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

  it("leaves speech-only DeepInfra out of the text providers", () => {
    clearEnv();
    process.env.DEEPINFRA_API_KEY = "di-server";
    expect(isProviderAvailable("deepinfra")).toBe(true);
    expect(getAvailableProviders({ deepinfraApiKey: "d" })).toEqual([]);
  });
});

describe("getSummarizationModelId", () => {
  it("prefers the user model", () => {
    clearEnv();
    process.env.SUMMARIZATION_MODEL = "groq:foo";
    expect(getSummarizationModelId("cerebras:bar", { cerebrasApiKey: "c" })).toBe("cerebras:bar");
  });

  it("falls back to the env var", () => {
    clearEnv();
    process.env.SUMMARIZATION_MODEL = "groq:foo";
    expect(getSummarizationModelId(null, {})).toBe("groq:foo");
  });

  it("defaults to the first configured provider by priority (Cerebras > Groq > Anthropic > OpenRouter)", () => {
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
    // A direct Anthropic key wins over the OpenRouter aggregator.
    expect(getSummarizationModelId(null, { anthropicApiKey: "a", openrouterApiKey: "o" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.anthropic
    );
    expect(getSummarizationModelId(null, { openrouterApiKey: "o" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.openrouter
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

  it("defaults to OpenRouter when it's the only JSON-mode provider configured", () => {
    clearEnv();
    expect(getNarrationModelRef(null, { openrouterApiKey: "o", anthropicApiKey: "a" })).toEqual({
      provider: "openrouter",
      model: "openai/gpt-oss-120b",
    });
  });

  it("accepts OpenRouter model IDs, including ones containing colons", () => {
    clearEnv();
    expect(
      getNarrationModelRef("openrouter:openai/gpt-oss-20b:free", { openrouterApiKey: "o" })
    ).toEqual({
      provider: "openrouter",
      model: "openai/gpt-oss-20b:free",
    });
  });

  it("uses the user model when set", () => {
    clearEnv();
    expect(getNarrationModelRef("groq:openai/gpt-oss-20b", { groqApiKey: "g" })).toEqual({
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
    process.env.ANTHROPIC_API_KEY = "sk-ant-server";
    process.env.GROQ_API_KEY = "gsk-server";
    const groqDefault = parseModelRef(DEFAULT_NARRATION_MODELS.groq);
    expect(getNarrationModelRef("anthropic:claude-sonnet-5")).toEqual(groqDefault);
    expect(getNarrationModelRef("some-bare-model")).toEqual(groqDefault);
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

describe("isUsableOpenRouterModel", () => {
  const base = {
    id: "openai/gpt-oss-120b",
    name: "OpenAI: gpt-oss-120b",
    context_length: 131072,
    architecture: { output_modalities: ["text"] },
    pricing: { prompt: "0.00000015", completion: "0.0000006" },
    supported_parameters: ["response_format", "reasoning", "temperature"],
  };

  it("keeps long-context, text-only chat models", () => {
    expect(isUsableOpenRouterModel(base)).toBe(true);
    expect(isUsableOpenRouterModel(base, { jsonObject: true })).toBe(true);
  });

  it("drops models that also generate images or audio", () => {
    expect(
      isUsableOpenRouterModel({ ...base, architecture: { output_modalities: ["image", "text"] } })
    ).toBe(false);
    expect(
      isUsableOpenRouterModel({ ...base, architecture: { output_modalities: ["text", "audio"] } })
    ).toBe(false);
  });

  it("drops short-context models", () => {
    expect(isUsableOpenRouterModel({ ...base, context_length: 8192 })).toBe(false);
  });

  it("drops async-only batch variants", () => {
    expect(isUsableOpenRouterModel({ ...base, id: "openai/gpt-oss-120b:batch" })).toBe(false);
  });

  it("drops routers with no fixed price", () => {
    expect(isUsableOpenRouterModel({ ...base, pricing: { prompt: "-1", completion: "-1" } })).toBe(
      false
    );
  });

  it("requires JSON mode support only when asked", () => {
    const noJson = { ...base, supported_parameters: ["temperature"] };
    expect(isUsableOpenRouterModel(noJson)).toBe(true);
    expect(isUsableOpenRouterModel(noJson, { jsonObject: true })).toBe(false);
  });
});

describe("isModelAllowed", () => {
  const allowed = ["openrouter:openai/gpt-oss-120b"];

  it("limits OpenRouter models to the allowed list on the server's key", () => {
    clearEnv();
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    expect(isModelAllowed("openrouter:openai/gpt-oss-120b", {}, allowed)).toBe(true);
    expect(isModelAllowed("openrouter:openai/o1-pro", {}, allowed)).toBe(false);
  });

  it("allows any OpenRouter model on the user's own key", () => {
    clearEnv();
    expect(isModelAllowed("openrouter:openai/o1-pro", { openrouterApiKey: "o" }, allowed)).toBe(
      true
    );
  });

  it("limits DeepInfra models the same way", () => {
    clearEnv();
    process.env.DEEPINFRA_API_KEY = "di-server";
    const speech = ["deepinfra:hexgrad/Kokoro-82M"];
    expect(isModelAllowed("deepinfra:hexgrad/Kokoro-82M", {}, speech)).toBe(true);
    expect(isModelAllowed("deepinfra:Qwen/Qwen3-TTS", {}, speech)).toBe(false);
    expect(isModelAllowed("deepinfra:Qwen/Qwen3-TTS", { deepinfraApiKey: "d" }, speech)).toBe(true);
  });

  it("doesn't restrict other providers", () => {
    clearEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-server";
    expect(isModelAllowed("anthropic:claude-opus-5", {}, allowed)).toBe(true);
    expect(isModelAllowed("claude-opus-5", {}, allowed)).toBe(true);
  });

  it("ignores a disallowed stored model when picking the model to run", () => {
    clearEnv();
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    expect(getSummarizationModelId("openrouter:openai/o1-pro", {})).toBe(
      DEFAULT_SUMMARIZATION_MODELS.openrouter
    );
    expect(getNarrationModelRef("openrouter:openai/o1-pro", {})).toEqual({
      provider: "openrouter",
      model: "openai/gpt-oss-120b",
    });
    expect(getSummarizationModelId("openrouter:openai/o1-pro", { openrouterApiKey: "o" })).toBe(
      "openrouter:openai/o1-pro"
    );
  });

  it("rejects a model whose provider has no key at all", () => {
    clearEnv();
    process.env.CEREBRAS_API_KEY = "csk-server";
    expect(isModelAllowed("anthropic:claude-opus-5", {}, allowed)).toBe(false);
    expect(isModelAllowed("openrouter:openai/gpt-oss-120b", {}, allowed)).toBe(false);
    expect(getSummarizationModelId("anthropic:claude-opus-5", {})).toBe(
      DEFAULT_SUMMARIZATION_MODELS.cerebras
    );
    expect(getNarrationModelRef("groq:openai/gpt-oss-120b", {})).toEqual(
      parseModelRef(DEFAULT_NARRATION_MODELS.cerebras)
    );
    expect(isModelAllowed("anthropic:claude-opus-5", { anthropicApiKey: "a" }, allowed)).toBe(true);
  });

  it("never summarizes with a speech-only provider", () => {
    clearEnv();
    process.env.GROQ_API_KEY = "gsk-server";
    expect(getSummarizationModelId("deepinfra:hexgrad/Kokoro-82M", { deepinfraApiKey: "d" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.groq
    );
  });
});

describe("buildChatCompletionBody (OpenRouter)", () => {
  const options = {
    system: "sys",
    userPrompt: "hi",
    maxTokens: 100,
    temperature: 0.1,
    reasoningEffort: "low" as const,
    jsonObject: true,
  };

  it("sends optional parameters only when the model supports them", () => {
    const body = buildChatCompletionBody("m", options, ["response_format"]);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).toMatchObject({
      model: "m",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      response_format: { type: "json_object" },
      provider: { sort: "throughput", require_parameters: true },
    });
  });

  it("includes supported parameters", () => {
    expect(
      buildChatCompletionBody("m", options, [
        "max_tokens",
        "temperature",
        "reasoning",
        "response_format",
      ])
    ).toMatchObject({ max_tokens: 100, temperature: 0.1, reasoning: { effort: "low" } });
  });

  it("only requires parameters for JSON mode", () => {
    const body = buildChatCompletionBody("m", { userPrompt: "hi", maxTokens: 100 }, []);
    expect(body).toMatchObject({ provider: { sort: "throughput" } });
    expect(body.provider).not.toHaveProperty("require_parameters");
    expect(body).not.toHaveProperty("response_format");
  });
});
