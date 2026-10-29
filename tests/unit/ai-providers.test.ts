import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import {
  classifyTextGenerationError,
  TextGenerationError,
  filterToLatestClaudeGeneration,
  generateChatCompletion,
  getAvailableProviders,
  getProviderApiKey,
  isModelAllowed,
  isProviderAvailable,
  isUsableOpenRouterModel,
  listAllModels,
  supportsReasoningEffort,
  type AiProviderKeys,
} from "@/server/services/ai-providers";
import { TEXT_AI_PROVIDERS } from "@/lib/ai/providers";
import { USER_AGENT } from "@/server/http/user-agent";
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
  "CEREBRAS_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPINFRA_API_KEY",
  "SUMMARIZATION_MODEL",
  "NARRATION_MODEL",
  "SERVER_KEY_MODELS",
  "SERVER_KEY_MAX_INPUT_PRICE",
  "SERVER_KEY_MAX_OUTPUT_PRICE",
  "SERVER_KEY_MAX_SPEECH_PRICE",
  "ANTHROPIC_BASE_URL",
  "MODEL_FAILOVER",
  "CEREBRAS_BASE_URL",
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
    expect(isProviderAvailable("openrouter", { cerebras: "csk-test" })).toBe(false);
    expect(getAvailableProviders({ openrouter: "sk-or-test", anthropic: "sk-test" })).toEqual([
      "anthropic",
      "openrouter",
    ]);
  });

  it("falls back to server env keys", () => {
    clearEnv();
    process.env.CEREBRAS_API_KEY = "csk-server";
    expect(isProviderAvailable("cerebras")).toBe(true);
    expect(getAvailableProviders({})).toEqual(["cerebras"]);
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
    process.env.SUMMARIZATION_MODEL = "openrouter:foo";
    expect(await getSummarizationModelId("cerebras:bar", { cerebras: "c" })).toBe("cerebras:bar");
  });

  it("falls back to the env var", async () => {
    clearEnv();
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    process.env.SUMMARIZATION_MODEL = "openrouter:foo";
    expect(await getSummarizationModelId(null, {})).toBe("openrouter:foo");
  });

  it("skips an env model that can't be used", async () => {
    clearEnv();
    process.env.CEREBRAS_API_KEY = "csk-server";
    process.env.SUMMARIZATION_MODEL = "openrouter:foo";
    expect(await getSummarizationModelId(null, {})).toBe(DEFAULT_SUMMARIZATION_MODELS.cerebras);
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    process.env.SERVER_KEY_MODELS = "cerebras:*";
    expect(await getSummarizationModelId(null, {})).toBe(DEFAULT_SUMMARIZATION_MODELS.cerebras);
  });

  it("defaults to the first configured provider by priority (Cerebras > Anthropic > OpenRouter)", async () => {
    clearEnv();
    // Cerebras wins over both others when configured.
    expect(await getSummarizationModelId(null, { openrouter: "o", cerebras: "c" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.cerebras
    );
    expect(await getSummarizationModelId(null, { anthropic: "a", cerebras: "c" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.cerebras
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

  it("defaults to the first configured provider (Cerebras before OpenRouter)", async () => {
    clearEnv();
    expect(await getNarrationModelRef(null, { openrouter: "o", cerebras: "c" })).toEqual(
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
    expect(await getNarrationModelRef("cerebras:qwen-3.8-27b", { cerebras: "c" })).toEqual({
      provider: "cerebras",
      model: "qwen-3.8-27b",
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
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    const openRouterDefault = parseModelRef(DEFAULT_NARRATION_MODELS.openrouter);
    expect(await getNarrationModelRef("anthropic:claude-sonnet-5")).toEqual(openRouterDefault);
    expect(await getNarrationModelRef("some-bare-model")).toEqual(openRouterDefault);
  });
});

describe("supportsReasoningEffort", () => {
  it("allows reasoning effort only for the gpt-oss family", () => {
    expect(supportsReasoningEffort("openai/gpt-oss-20b")).toBe(true);
    expect(supportsReasoningEffort("gpt-oss-120b")).toBe(true);
    // Cerebras 400s on reasoning_effort for non-reasoning models
    expect(supportsReasoningEffort("meta-llama/llama-4-scout-17b-16e-instruct")).toBe(false);
    expect(supportsReasoningEffort("llama-3.3-70b-versatile")).toBe(false);
    expect(supportsReasoningEffort("qwen-3-32b")).toBe(false);
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
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    process.env.SERVER_KEY_MODELS = DEFAULT_SUMMARIZATION_MODELS.openrouter;
    expect(await getSummarizationModelId(null, {})).toBe(DEFAULT_SUMMARIZATION_MODELS.openrouter);
    expect(await getNarrationModelRef(null, {})).toEqual(
      parseModelRef(DEFAULT_NARRATION_MODELS.openrouter)
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
    expect(await getNarrationModelRef("openrouter:openai/gpt-oss-120b", {})).toEqual(
      parseModelRef(DEFAULT_NARRATION_MODELS.cerebras)
    );
    expect(isModelAllowed("anthropic:claude-opus-5", { anthropic: "a" })).toBe(true);
  });

  it("reports summarization unavailable when no model can be used", async () => {
    clearEnv();
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    expect(await isSummarizationAvailable({})).toBe(true);
    process.env.SERVER_KEY_MODELS = "cerebras:*";
    expect(await isSummarizationAvailable({})).toBe(false);
    expect(await isNarrationLlmAvailable({})).toBe(false);
    expect(await isSummarizationAvailable({ openrouter: "o" })).toBe(true);
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
    process.env.CEREBRAS_API_KEY = "csk-server";
    expect(await getSummarizationModelId("deepinfra:hexgrad/Kokoro-82M", { deepinfra: "d" })).toBe(
      DEFAULT_SUMMARIZATION_MODELS.cerebras
    );
  });
});

describe("generateChatCompletion", () => {
  it("refuses a model the server's key doesn't allow, before calling the provider", async () => {
    clearEnv();
    process.env.CEREBRAS_API_KEY = "csk-server";
    process.env.SERVER_KEY_MODELS = DEFAULT_SUMMARIZATION_MODELS.cerebras;
    await expect(
      generateChatCompletion(
        parseModelRef("cerebras:qwen-3.8-27b"),
        {},
        {
          userPrompt: "hi",
          maxTokens: 10,
        }
      )
    ).rejects.toThrow("isn't allowed on the server's Cerebras key");
  });

  describe("against a stand-in provider", () => {
    let server: Server;
    const requests: { url: string; userAgent: string | undefined; apiKey: string | undefined }[] =
      [];
    /** What Cerebras (the OpenAI-shaped path) answers instead, if anything. */
    let cerebrasFailure: number | null = null;
    /** What Anthropic answers instead, if anything. */
    let anthropicFailure: number | null = null;

    beforeAll(async () => {
      server = createServer((req, res) => {
        requests.push({
          url: req.url ?? "",
          userAgent: req.headers["user-agent"],
          // Anthropic sends `x-api-key`; the OpenAI-compatible SDKs a bearer token.
          apiKey:
            (req.headers["x-api-key"] as string | undefined) ??
            req.headers.authorization?.replace(/^Bearer /, ""),
        });
        res.setHeader("Content-Type", "application/json");
        const failure = req.url?.includes("/chat/completions") ? cerebrasFailure : anthropicFailure;
        if (failure) {
          res.statusCode = failure;
          res.end(JSON.stringify({ error: { message: "No." } }));
          return;
        }
        // Both the Anthropic and the OpenAI-compatible answer shapes.
        res.end(
          JSON.stringify({
            content: [{ type: "text", text: "hello" }],
            choices: [{ message: { content: "hello" } }],
          })
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    });

    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    function pointSdksAtServer() {
      clearEnv();
      requests.length = 0;
      cerebrasFailure = null;
      anthropicFailure = null;
      const { port } = server.address() as AddressInfo;
      for (const name of ["ANTHROPIC_BASE_URL", "CEREBRAS_BASE_URL"] as const) {
        process.env[name] = `http://127.0.0.1:${port}`;
      }
    }

    it.each(["anthropic", "cerebras"] as const)(
      "calls %s with our User-Agent",
      async (provider) => {
        pointSdksAtServer();
        const text = await generateChatCompletion(
          { provider, model: "some-model" },
          { [provider]: "user-key" },
          { userPrompt: "hi", maxTokens: 10 }
        );
        expect(text).toBe("hello");
        expect(requests.map((request) => request.userAgent)).toEqual([USER_AGENT]);
      }
    );

    it.each(["anthropic", "cerebras"] as const)(
      "calls %s with each request's own key, never a previous one",
      async (provider) => {
        pointSdksAtServer();
        const options = { userPrompt: "hi", maxTokens: 10 };
        const model = { provider, model: "some-model" };
        await generateChatCompletion(model, { [provider]: "user-key-a" }, options);
        await generateChatCompletion(model, { [provider]: "user-key-b" }, options);
        const envVar = `${provider.toUpperCase()}_API_KEY`;
        process.env[envVar] = "server-key-1";
        await generateChatCompletion(model, {}, options);
        process.env[envVar] = "server-key-2";
        await generateChatCompletion(model, {}, options);
        expect(requests.map((request) => request.apiKey)).toEqual([
          "user-key-a",
          "user-key-b",
          "server-key-1",
          "server-key-2",
        ]);
      }
    );

    describe("failover", () => {
      // Anthropic stands in for another host of the model.
      const model = { provider: "cerebras" as const, model: "some-model" };
      const options = { userPrompt: "hi", maxTokens: 10 };
      const asked = () =>
        requests.map((request) => [
          request.url.includes("/chat/completions") ? "cerebras" : "anthropic",
          request.apiKey,
        ]);

      beforeEach(() => {
        pointSdksAtServer();
        process.env.MODEL_FAILOVER = "cerebras:some-model,anthropic:some-model;x:y,z:w";
        process.env.CEREBRAS_API_KEY = "server-c";
        process.env.ANTHROPIC_API_KEY = "server-a";
      });

      it.each([
        ["is busy", 429],
        ["fails", 500],
        ["refuses its key, as when it's out of credit", 402],
      ])("goes to the model's next host when the first %s", async (_, status) => {
        cerebrasFailure = status;
        expect(await generateChatCompletion(model, {}, options)).toBe("hello");
        expect(asked().at(-1)).toEqual(["anthropic", "server-a"]);
      });

      it("allows a failover on the server's key that users can't pick", async () => {
        process.env.SERVER_KEY_MODELS = "cerebras:some-model";
        cerebrasFailure = 503;
        expect(await generateChatCompletion(model, {}, options)).toBe("hello");
        expect(asked().at(-1)).toEqual(["anthropic", "server-a"]);
      });

      it("backs the user's own key up with the server's, never another of theirs", async () => {
        cerebrasFailure = 402;
        await generateChatCompletion(model, { cerebras: "user-c", anthropic: "user-a" }, options);
        expect(asked()).toEqual([
          ["cerebras", "user-c"],
          ["anthropic", "server-a"],
        ]);
      });

      it("throws the first host's error when every host fails", async () => {
        cerebrasFailure = 402;
        anthropicFailure = 503;
        await expect(
          generateChatCompletion(model, { cerebras: "user-c" }, options)
        ).rejects.toMatchObject({ failure: "rejected", provider: "cerebras", usedUserKey: true });
        expect(asked().at(-1)?.[0]).toBe("anthropic");
      });

      it("skips a host that can't do what's asked", async () => {
        cerebrasFailure = 503;
        await expect(
          generateChatCompletion(model, {}, { ...options, jsonObject: true })
        ).rejects.toMatchObject({ failure: "busy", provider: "cerebras" });
        expect(asked().map(([provider]) => provider)).not.toContain("anthropic");
      });
    });

    it("never asks a provider that can't do JSON mode for it, nor lists its models", async () => {
      pointSdksAtServer();
      await expect(
        generateChatCompletion(
          { provider: "anthropic", model: "claude-haiku-4-5" },
          { anthropic: "user-key" },
          { userPrompt: "hi", maxTokens: 10, jsonObject: true }
        )
      ).rejects.toThrow("JSON-object responses are not supported for Anthropic");
      expect(
        await listAllModels({ anthropic: "user-key" }, TEXT_AI_PROVIDERS, { jsonObject: true })
      ).toEqual([]);
      expect(requests).toEqual([]);
    });
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
      classifyTextGenerationError(Cerebras.APIError.generate(503, undefined, "busy", {}))
    ).toBe("busy");
    // A timeout
    expect(
      classifyTextGenerationError(Cerebras.APIError.generate(408, undefined, "slow", {}))
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
    for (const status of [400, 401, 402, 408, 409, 429, 500, 502, 503, 504, 529]) {
      const sdkError = Cerebras.APIError.generate(status, undefined, "x", {});
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

    const cerebras = Cerebras.APIError.generate(
      400,
      { error: { message: "model not found", type: "invalid_request_error" } },
      undefined,
      {}
    );
    expect(new TextGenerationError("cerebras", "rejected", true, cerebras).providerMessage).toBe(
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
      new TextGenerationError("cerebras", "failed", true, new Error("socket hang up"))
        .providerMessage
    ).toBe("socket hang up");
  });
});
