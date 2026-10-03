import { describe, it, expect, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import Groq from "groq-sdk";
import {
  classifyTextGenerationError,
  TextGenerationError,
  filterToLatestClaudeGeneration,
  generateChatCompletion,
  getAvailableProviders,
  getProviderApiKey,
  isChatModelId,
  isModelAllowed,
  isProviderAvailable,
  isUsableOpenRouterModel,
  supportsReasoningEffort,
  type AiProviderKeys,
} from "@/server/services/ai-providers";
import { getNarrationModelRef, isNarrationLlmAvailable } from "@/server/services/narration";
import { parseModelRef } from "@/lib/ai/model-ref";
import {
  buildChatCompletionBody,
  chatCompletionText,
  OpenRouterChatError,
} from "@/server/services/openrouter";
import { UNREADABLE_API_KEY } from "@/server/services/unreadable-api-key";
import { classifyProviderStatus } from "@/server/services/provider-errors";
import { getSummarizationModelId, isSummarizationAvailable } from "@/server/services/summarization";
import { serverKeyTokenPriceCaps } from "@/server/services/server-key-models";
import {
  DEFAULT_SUMMARIZATION_MODELS,
  SUMMARIZATION_PROVIDER_PRIORITY,
} from "@/lib/summarization/constants";
import { DEFAULT_NARRATION_MODELS, NARRATION_PROVIDERS } from "@/lib/narration/constants";

const ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPINFRA_API_KEY",
  "SUMMARIZATION_MODEL",
  "NARRATION_MODEL",
  "SERVER_KEY_MODELS",
  "SERVER_KEY_MAX_INPUT_PRICE",
  "SERVER_KEY_MAX_OUTPUT_PRICE",
  "SERVER_KEY_MAX_SPEECH_PRICE",
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
  it("keeps a provider whose saved key can't be read off the server's key", () => {
    clearEnv();
    process.env.DEEPINFRA_API_KEY = "server-key";
    const keys: AiProviderKeys = { deepinfra: UNREADABLE_API_KEY };
    // Still the user's own provider, so callers reach its clear error...
    expect(isProviderAvailable("deepinfra", keys)).toBe(true);
    // ...but there's no key to call it with, the server's included.
    expect(getProviderApiKey("deepinfra", keys)).toBeNull();
    expect(getProviderApiKey("deepinfra", {})).toBe("server-key");
  });

  it("uses per-user keys", () => {
    clearEnv();
    expect(isProviderAvailable("cerebras", { cerebras: "csk-test" })).toBe(true);
    expect(isProviderAvailable("groq", { cerebras: "csk-test" })).toBe(false);
    expect(getAvailableProviders({ groq: "gsk-test", anthropic: "sk-test" })).toEqual([
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
    expect(getAvailableProviders({ deepinfra: "d" })).toEqual([]);
  });
});

describe("getSummarizationModelId", () => {
  it("prefers the user model", async () => {
    clearEnv();
    process.env.SUMMARIZATION_MODEL = "groq:foo";
    expect(await getSummarizationModelId("cerebras:bar", { cerebras: "c" })).toBe("cerebras:bar");
  });

  it("falls back to the env var", async () => {
    clearEnv();
    process.env.GROQ_API_KEY = "gsk-server";
    process.env.SUMMARIZATION_MODEL = "groq:foo";
    expect(await getSummarizationModelId(null, {})).toBe("groq:foo");
  });

  it("skips an env model that can't be used", async () => {
    clearEnv();
    process.env.CEREBRAS_API_KEY = "csk-server";
    process.env.SUMMARIZATION_MODEL = "groq:foo";
    expect(await getSummarizationModelId(null, {})).toBe(DEFAULT_SUMMARIZATION_MODELS.cerebras);
    process.env.GROQ_API_KEY = "gsk-server";
    process.env.SERVER_KEY_MODELS = "cerebras:*";
    expect(await getSummarizationModelId(null, {})).toBe(DEFAULT_SUMMARIZATION_MODELS.cerebras);
  });

  it("defaults to the first configured provider by priority (Cerebras > Groq > Anthropic > OpenRouter)", async () => {
    clearEnv();
    // Cerebras wins over both others when configured.
    expect(await getSummarizationModelId(null, { groq: "g", cerebras: "c" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.cerebras
    );
    expect(await getSummarizationModelId(null, { anthropic: "a", cerebras: "c" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.cerebras
    );
    // Groq wins over Anthropic.
    expect(await getSummarizationModelId(null, { anthropic: "a", groq: "g" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.groq
    );
    // A direct Anthropic key wins over the OpenRouter aggregator.
    expect(await getSummarizationModelId(null, { anthropic: "a", openrouter: "o" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.anthropic
    );
    expect(await getSummarizationModelId(null, { openrouter: "o" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.openrouter
    );
    // Anthropic only when it's the sole option.
    expect(await getSummarizationModelId(null, { anthropic: "a" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.anthropic
    );
  });

  it("defaults to the first-priority provider when nothing is configured", async () => {
    clearEnv();
    expect(await getSummarizationModelId(null, {})).toBe(
      DEFAULT_SUMMARIZATION_MODELS[SUMMARIZATION_PROVIDER_PRIORITY[0]]
    );
  });
});

describe("getNarrationModelRef", () => {
  it("defaults to the first-preference provider's model when nothing is configured", async () => {
    clearEnv();
    expect(await getNarrationModelRef(null)).toEqual(
      parseModelRef(DEFAULT_NARRATION_MODELS[NARRATION_PROVIDERS[0]])
    );
  });

  it("defaults to the first configured provider (Cerebras before Groq)", async () => {
    clearEnv();
    // Only Groq configured → Groq default.
    expect(await getNarrationModelRef(null, { groq: "g" })).toEqual(
      parseModelRef(DEFAULT_NARRATION_MODELS.groq)
    );
    // Both configured → Cerebras wins (fastest, listed first).
    expect(await getNarrationModelRef(null, { groq: "g", cerebras: "c" })).toEqual(
      parseModelRef(DEFAULT_NARRATION_MODELS.cerebras)
    );
  });

  it("defaults to OpenRouter when it's the only JSON-mode provider configured", async () => {
    clearEnv();
    expect(await getNarrationModelRef(null, { openrouter: "o", anthropic: "a" })).toEqual(
      parseModelRef(DEFAULT_NARRATION_MODELS.openrouter)
    );
  });

  it("accepts OpenRouter model IDs, including ones containing colons", async () => {
    clearEnv();
    expect(
      await getNarrationModelRef("openrouter:openai/gpt-oss-20b:free", { openrouter: "o" })
    ).toEqual({
      provider: "openrouter",
      model: "openai/gpt-oss-20b:free",
    });
  });

  it("uses the user model when set", async () => {
    clearEnv();
    expect(await getNarrationModelRef("groq:openai/gpt-oss-20b", { groq: "g" })).toEqual({
      provider: "groq",
      model: "openai/gpt-oss-20b",
    });
  });

  it("uses the env var when the user model is unset", async () => {
    clearEnv();
    process.env.CEREBRAS_API_KEY = "csk-server";
    process.env.NARRATION_MODEL = "cerebras:llama-3.3-70b";
    expect(await getNarrationModelRef(null)).toEqual({
      provider: "cerebras",
      model: "llama-3.3-70b",
    });
  });

  it("falls back to the default for non-OpenAI-compatible references", async () => {
    clearEnv();
    // Anthropic models can't do JSON-object responses, and a legacy bare ID
    // parses as Anthropic — both must fall back to the default model.
    process.env.ANTHROPIC_API_KEY = "sk-ant-server";
    process.env.GROQ_API_KEY = "gsk-server";
    const groqDefault = parseModelRef(DEFAULT_NARRATION_MODELS.groq);
    expect(await getNarrationModelRef("anthropic:claude-sonnet-5")).toEqual(groqDefault);
    expect(await getNarrationModelRef("some-bare-model")).toEqual(groqDefault);
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
  it("allows every model on the server's keys by default", () => {
    clearEnv();
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    expect(isModelAllowed("openrouter:openai/o1-pro", {})).toBe(true);
  });

  it("limits the server's keys to the listed models", () => {
    clearEnv();
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    process.env.ANTHROPIC_API_KEY = "sk-ant-server";
    process.env.SERVER_KEY_MODELS = " openrouter:openai/gpt-oss-120b , claude-haiku-5 ";
    expect(isModelAllowed("openrouter:openai/gpt-oss-120b", {})).toBe(true);
    expect(isModelAllowed("openrouter:openai/o1-pro", {})).toBe(false);
    // Bare IDs are Anthropic's, whichever side they're on.
    expect(isModelAllowed("anthropic:claude-haiku-5", {})).toBe(true);
    expect(isModelAllowed("claude-opus-5", {})).toBe(false);
  });

  it("allows a whole provider with provider:*", () => {
    clearEnv();
    process.env.CEREBRAS_API_KEY = "csk-server";
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    process.env.SERVER_KEY_MODELS = "cerebras:*";
    expect(isModelAllowed("cerebras:llama-3.3-70b", {})).toBe(true);
    expect(isModelAllowed("openrouter:cerebras/llama-3.3-70b", {})).toBe(false);
  });

  it("allows text models priced within both caps", () => {
    clearEnv();
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    process.env.SERVER_KEY_MAX_INPUT_PRICE = "0.35";
    process.env.SERVER_KEY_MAX_OUTPUT_PRICE = "0.75";
    const model = "openrouter:some/model";
    const price = (input?: number, output?: number) => ({
      inputPricePerMillion: input,
      outputPricePerMillion: output,
    });
    expect(isModelAllowed(model, {}, price(0.35, 0.75))).toBe(true);
    expect(isModelAllowed(model, {}, price(0, 0))).toBe(true);
    expect(isModelAllowed(model, {}, price(0.01, 0.8))).toBe(false);
    expect(isModelAllowed(model, {}, price(0.4, 0.1))).toBe(false);
    // An unknown price is never within a cap.
    expect(isModelAllowed(model, {}, price(0.01, undefined))).toBe(false);
    expect(isModelAllowed(model, {})).toBe(false);
  });

  it("checks only the caps that are set", () => {
    clearEnv();
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    process.env.SERVER_KEY_MAX_OUTPUT_PRICE = "1";
    const price = { inputPricePerMillion: 5, outputPricePerMillion: 1 };
    expect(isModelAllowed("openrouter:some/model", {}, price)).toBe(true);
  });

  it("allows speech models by the speech cap, not the token caps", () => {
    clearEnv();
    process.env.DEEPINFRA_API_KEY = "di-server";
    process.env.SERVER_KEY_MAX_INPUT_PRICE = "100";
    process.env.SERVER_KEY_MAX_OUTPUT_PRICE = "100";
    const kokoro = { pricePerMillionCharacters: 0.93 };
    expect(isModelAllowed("deepinfra:hexgrad/Kokoro-82M", {}, kokoro)).toBe(false);
    process.env.SERVER_KEY_MAX_SPEECH_PRICE = "1";
    expect(isModelAllowed("deepinfra:hexgrad/Kokoro-82M", {}, kokoro)).toBe(true);
    expect(isModelAllowed("deepinfra:Qwen/Qwen3-TTS", {}, { pricePerMillionCharacters: 20 })).toBe(
      false
    );
  });

  it("allows nothing by an unparseable cap", () => {
    clearEnv();
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    process.env.SERVER_KEY_MAX_SPEECH_PRICE = "one dollar";
    expect(isModelAllowed("openrouter:a/b", {}, { pricePerMillionCharacters: 0 })).toBe(false);
  });

  it("allows any model on the user's own key", () => {
    clearEnv();
    process.env.SERVER_KEY_MODELS = "cerebras:gpt-oss-120b";
    expect(isModelAllowed("openrouter:openai/o1-pro", { openrouter: "o" })).toBe(true);
    expect(isModelAllowed("deepinfra:Qwen/Qwen3-TTS", { deepinfra: "d" })).toBe(true);
  });

  it("isn't unlocked by the user's key for another provider", () => {
    clearEnv();
    process.env.DEEPINFRA_API_KEY = "di-server";
    process.env.SERVER_KEY_MODELS = "deepinfra:hexgrad/Kokoro-82M";
    expect(isModelAllowed("deepinfra:Qwen/Qwen3-TTS", { openrouter: "o" })).toBe(false);
  });

  it("ignores a disallowed stored model when picking the model to run", async () => {
    clearEnv();
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    process.env.SERVER_KEY_MODELS = "openrouter:openai/gpt-oss-120b";
    expect(await getSummarizationModelId("openrouter:openai/o1-pro", {})).toBe(
      DEFAULT_SUMMARIZATION_MODELS.openrouter
    );
    expect(await getNarrationModelRef("openrouter:openai/o1-pro", {})).toEqual({
      provider: "openrouter",
      model: "openai/gpt-oss-120b",
    });
    expect(await getSummarizationModelId("openrouter:openai/o1-pro", { openrouter: "o" })).toBe(
      "openrouter:openai/o1-pro"
    );
  });

  it("skips a provider whose default isn't allowed when picking the default", async () => {
    clearEnv();
    process.env.CEREBRAS_API_KEY = "csk-server";
    process.env.GROQ_API_KEY = "gsk-server";
    process.env.SERVER_KEY_MODELS = DEFAULT_SUMMARIZATION_MODELS.groq;
    expect(await getSummarizationModelId(null, {})).toBe(DEFAULT_SUMMARIZATION_MODELS.groq);
    expect(await getNarrationModelRef(null, {})).toEqual(
      parseModelRef(DEFAULT_NARRATION_MODELS.groq)
    );
  });

  it("rejects a model whose provider has no key at all", async () => {
    clearEnv();
    process.env.CEREBRAS_API_KEY = "csk-server";
    expect(isModelAllowed("anthropic:claude-opus-5", {})).toBe(false);
    expect(isModelAllowed("openrouter:openai/gpt-oss-120b", {})).toBe(false);
    expect(await getSummarizationModelId("anthropic:claude-opus-5", {})).toBe(
      DEFAULT_SUMMARIZATION_MODELS.cerebras
    );
    expect(await getNarrationModelRef("groq:openai/gpt-oss-120b", {})).toEqual(
      parseModelRef(DEFAULT_NARRATION_MODELS.cerebras)
    );
    expect(isModelAllowed("anthropic:claude-opus-5", { anthropic: "a" })).toBe(true);
  });

  it("reports summarization unavailable when no model can be used", async () => {
    clearEnv();
    process.env.GROQ_API_KEY = "gsk-server";
    expect(await isSummarizationAvailable({})).toBe(true);
    process.env.SERVER_KEY_MODELS = "cerebras:*";
    expect(await isSummarizationAvailable({})).toBe(false);
    expect(await isNarrationLlmAvailable({})).toBe(false);
    expect(await isSummarizationAvailable({ groq: "g" })).toBe(true);
  });

  it("holds only price-allowed models to the price caps", () => {
    clearEnv();
    expect(serverKeyTokenPriceCaps("openrouter:a/b")).toBeNull();
    process.env.SERVER_KEY_MODELS = "openrouter:openai/gpt-oss-120b";
    process.env.SERVER_KEY_MAX_INPUT_PRICE = "0.35";
    process.env.SERVER_KEY_MAX_OUTPUT_PRICE = "0.75";
    expect(serverKeyTokenPriceCaps("openrouter:openai/gpt-oss-120b")).toBeNull();
    expect(serverKeyTokenPriceCaps("openrouter:a/b")).toEqual({
      maxInputPrice: 0.35,
      maxOutputPrice: 0.75,
    });
  });

  it("never summarizes with a speech-only provider", async () => {
    clearEnv();
    process.env.GROQ_API_KEY = "gsk-server";
    expect(await getSummarizationModelId("deepinfra:hexgrad/Kokoro-82M", { deepinfra: "d" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.groq
    );
  });
});

describe("generateChatCompletion", () => {
  it("refuses a model the server's key doesn't allow, before calling the provider", async () => {
    clearEnv();
    process.env.GROQ_API_KEY = "gsk-server";
    process.env.SERVER_KEY_MODELS = DEFAULT_SUMMARIZATION_MODELS.groq;
    await expect(
      generateChatCompletion(
        parseModelRef("groq:qwen/qwen3-32b"),
        {},
        {
          userPrompt: "hi",
          maxTokens: 10,
        }
      )
    ).rejects.toThrow("isn't allowed on the server's Groq key");
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

  it("keeps to the price caps it's given", () => {
    const options = { userPrompt: "hi", maxTokens: 100 };
    expect(
      buildChatCompletionBody("m", options, [], { maxInputPrice: 0.35, maxOutputPrice: 0.75 })
    ).toMatchObject({ provider: { max_price: { prompt: 0.35, completion: 0.75 } } });
    expect(buildChatCompletionBody("m", options, []).provider).not.toHaveProperty("max_price");
  });
});

describe("classifyTextGenerationError", () => {
  const headers = new Headers();

  it("treats rate limiting and overload as busy", () => {
    expect(
      classifyTextGenerationError(Anthropic.APIError.generate(429, undefined, "slow", headers))
    ).toBe("busy");
    // Anthropic's "overloaded"
    expect(
      classifyTextGenerationError(Anthropic.APIError.generate(529, undefined, "busy", headers))
    ).toBe("busy");
    expect(
      classifyTextGenerationError(Groq.APIError.generate(503, undefined, "busy", headers))
    ).toBe("busy");
    // A timeout, and Groq's flex tier out of capacity
    expect(
      classifyTextGenerationError(Groq.APIError.generate(408, undefined, "slow", headers))
    ).toBe("busy");
    expect(
      classifyTextGenerationError(Groq.APIError.generate(498, undefined, "full", headers))
    ).toBe("busy");
    expect(classifyTextGenerationError(new OpenRouterChatError(429, "slow down"))).toBe("busy");
  });

  it("classifies OpenRouter's failures by status, or for one in a 200 body, its code", () => {
    const failureOf = (status: number, body: unknown): unknown => {
      try {
        chatCompletionText(status, body);
      } catch (error) {
        return error;
      }
      throw new Error("expected a failure");
    };

    const upstream = failureOf(200, { error: { code: 429, message: "Provider returned error" } });
    expect(classifyTextGenerationError(upstream)).toBe("busy");
    expect(new TextGenerationError("openrouter", "busy", true, upstream).providerMessage).toBe(
      "Provider returned error"
    );

    const refused = failureOf(402, { error: { code: 402, message: "Insufficient credits" } });
    expect(classifyTextGenerationError(refused)).toBe("rejected");
    expect(new TextGenerationError("openrouter", "rejected", true, refused).providerMessage).toBe(
      "Insufficient credits"
    );
    // Not JSON at all: the status still decides.
    expect(classifyTextGenerationError(failureOf(503, null))).toBe("busy");

    expect(chatCompletionText(200, { choices: [{ message: { content: "ok" } }] })).toBe("ok");
  });

  it("treats an unreachable provider as busy", () => {
    expect(classifyTextGenerationError(new Anthropic.APIConnectionError({}))).toBe("busy");
    expect(classifyTextGenerationError(new Cerebras.APIConnectionTimeoutError())).toBe("busy");
    expect(classifyTextGenerationError(new TypeError("fetch failed"))).toBe("busy");
    expect(classifyTextGenerationError(new DOMException("timed out", "TimeoutError"))).toBe("busy");
  });

  it("treats other 4xx answers as rejections", () => {
    expect(
      classifyTextGenerationError(Anthropic.APIError.generate(401, undefined, "bad key", headers))
    ).toBe("rejected");
    expect(
      classifyTextGenerationError(Cerebras.APIError.generate(400, undefined, "bad model", {}))
    ).toBe("rejected");
    expect(classifyTextGenerationError(new OpenRouterChatError(402, "no credit"))).toBe("rejected");
  });

  it("reads a status the way speech does", () => {
    for (const status of [400, 401, 402, 408, 409, 429, 498, 500, 502, 503, 504, 529]) {
      const sdkError = Groq.APIError.generate(status, undefined, "x", headers);
      expect(classifyTextGenerationError(sdkError)).toBe(classifyProviderStatus(status));
    }
  });

  it("treats anything else as a failure", () => {
    expect(
      classifyTextGenerationError(Anthropic.APIError.generate(500, undefined, "oops", headers))
    ).toBe("failed");
    expect(classifyTextGenerationError(new Error("something else"))).toBe("failed");
    expect(classifyTextGenerationError("not even an error")).toBe("failed");
  });
});

describe("TextGenerationError.providerMessage", () => {
  it("is the provider's own explanation, not the SDK's status and JSON body", () => {
    const anthropic = Anthropic.APIError.generate(
      401,
      { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
      undefined,
      new Headers()
    );
    expect(anthropic.message).not.toBe("invalid x-api-key");
    expect(new TextGenerationError("anthropic", "rejected", true, anthropic).providerMessage).toBe(
      "invalid x-api-key"
    );

    const groq = Groq.APIError.generate(
      400,
      { error: { message: "model not found", type: "invalid_request_error" } },
      undefined,
      new Headers()
    );
    expect(new TextGenerationError("groq", "rejected", true, groq).providerMessage).toBe(
      "model not found"
    );

    expect(
      new TextGenerationError(
        "openrouter",
        "rejected",
        true,
        new OpenRouterChatError(402, "no credit")
      ).providerMessage
    ).toBe("no credit");
  });

  it("falls back to the error's message when there's no explanation", () => {
    expect(
      new TextGenerationError("groq", "failed", true, new Error("socket hang up")).providerMessage
    ).toBe("socket hang up");
  });
});
