/**
 * Generic AI provider layer.
 *
 * Puts the text providers (`@/lib/ai/providers`) behind one interface, the
 * adapters in {@link TEXT_PROVIDER_ADAPTERS}, so features (summarization,
 * narration preprocessing) can run on any configured one. A user's own key
 * for a provider overrides the server's (`<PROVIDER>_API_KEY`); a provider is
 * "available" when either is set.
 */

import Anthropic from "@anthropic-ai/sdk";
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import Groq from "groq-sdk";
import { logger } from "@/lib/logger";
import { formatModelRef, parseModelRef, type ModelRef } from "@/lib/ai/model-ref";
import {
  AI_PROVIDERS,
  aiProviderName,
  isTextAiProvider,
  TEXT_AI_PROVIDERS,
  type AiProvider,
  type TextAiProvider,
} from "@/lib/ai/providers";
import { USER_AGENT } from "@/server/http/user-agent";
import {
  listOpenRouterModels,
  OpenRouterChatError,
  openRouterChatCompletion,
  openRouterTextModelPrice,
  pricePerMillionUnits,
  type OpenRouterModel,
} from "@/server/services/openrouter";
import {
  hasServerKeyPriceCaps,
  isAllowedOnServerKey,
  serverKeyTokenPriceCaps,
  type ModelPrice,
} from "@/server/services/server-key-models";
import { UNREADABLE_API_KEY } from "@/server/services/unreadable-api-key";
import {
  classifyProviderStatus,
  isFetchConnectionError,
  type ProviderFailure,
} from "@/server/services/provider-errors";

/**
 * Per-user provider API keys, as `getUserApiKeys` returns them. A missing or
 * null entry falls back to the server's key; {@link UNREADABLE_API_KEY} doesn't.
 */
export type AiProviderKeys = Partial<Record<AiProvider, string | null | typeof UNREADABLE_API_KEY>>;

/** A call to a provider whose saved key can't be read. */
export class UnreadableApiKeyError extends Error {
  constructor(readonly provider: AiProvider) {
    super(
      `Your saved ${aiProviderName(provider)} API key can't be read; enter it again in Settings.`
    );
  }
}

/** Each provider's server key: `<PROVIDER>_API_KEY`. */
export const AI_PROVIDER_ENV_KEYS = Object.fromEntries(
  AI_PROVIDERS.map((provider) => [provider, `${provider.toUpperCase()}_API_KEY`])
) as Record<AiProvider, string>;

function userKeyFor(provider: AiProvider, keys?: AiProviderKeys): string | null {
  const key = keys?.[provider];
  return typeof key === "string" && key ? key : null;
}

/** Whether calls to the provider are the user's own (their key, even an unreadable one). */
export function isOnUserKey(provider: AiProvider, keys?: AiProviderKeys): boolean {
  return !!userKeyFor(provider, keys) || keys?.[provider] === UNREADABLE_API_KEY;
}

/**
 * The user's key for the provider, else the server's, else null. Null, not the
 * server's, when the user's saved key can't be read.
 */
export function getProviderApiKey(provider: AiProvider, keys?: AiProviderKeys): string | null {
  if (keys?.[provider] === UNREADABLE_API_KEY) return null;
  return userKeyFor(provider, keys) ?? process.env[AI_PROVIDER_ENV_KEYS[provider]] ?? null;
}

/**
 * Checks whether a provider can be used (user key or server env key set).
 */
export function isProviderAvailable(provider: AiProvider, keys?: AiProviderKeys): boolean {
  return isOnUserKey(provider, keys) || !!process.env[AI_PROVIDER_ENV_KEYS[provider]];
}

/**
 * Whether a model can be used: its provider has a key, and a request billed to
 * the server's key (the user has none of their own for that provider) is for
 * a model allowed there (see `server-key-models.ts`, which may need its price).
 */
export function isModelAllowed(
  modelRef: string,
  keys: AiProviderKeys | undefined,
  price?: ModelPrice
): boolean {
  const { provider } = parseModelRef(modelRef);
  if (!isProviderAvailable(provider, keys)) return false;
  return isOnUserKey(provider, keys) || isAllowedOnServerKey(modelRef, price);
}

/** {@link isModelAllowed} for a text model, looking up its price if that's what decides. */
export async function isTextModelAllowed(
  modelRef: string,
  keys: AiProviderKeys | undefined
): Promise<boolean> {
  if (isModelAllowed(modelRef, keys)) return true;
  const { provider, model } = parseModelRef(modelRef);
  if (
    provider !== "openrouter" ||
    !hasServerKeyPriceCaps() ||
    !isProviderAvailable(provider, keys)
  ) {
    return false;
  }
  return isModelAllowed(modelRef, keys, await openRouterTextModelPrice(model));
}

/**
 * Lists the text providers that can currently be used, in declaration order.
 */
export function getAvailableProviders(keys?: AiProviderKeys): TextAiProvider[] {
  return TEXT_AI_PROVIDERS.filter((provider) => isProviderAvailable(provider, keys));
}

/**
 * How long a text request may take in all, retries included: enough for a
 * slow reasoning model, but a hung provider doesn't hold a summary nobody's
 * still waiting for (the SDK defaults, Anthropic's 10 minutes and two retries
 * everywhere, would).
 */
const TEXT_REQUEST_BUDGET_MS = 120_000;

/**
 * The SDK providers retry a failed attempt (no connection, a 429 or 5xx)
 * once, each attempt getting its share of the budget. OpenRouter's request
 * isn't retried, since OpenRouter already falls back across the hosts serving
 * a model: it gets the whole budget.
 */
const SDK_RETRIES = 1;

const SDK_CLIENT_OPTIONS = {
  timeout: TEXT_REQUEST_BUDGET_MS / (SDK_RETRIES + 1),
  maxRetries: SDK_RETRIES,
  defaultHeaders: { "User-Agent": USER_AGENT },
};

/** The key a provider is called with. */
interface ProviderCall {
  apiKey: string;
  /** It's the user's own key, so the server key's limits don't apply. */
  onUserKey: boolean;
}

/**
 * An SDK's client for a call: for the server's key, one created on first use;
 * for a user's, a fresh one each time (never cached).
 */
function sdkClient<C>(
  create: (options: typeof SDK_CLIENT_OPTIONS & { apiKey: string }) => C
): (call: ProviderCall) => C {
  let server: { apiKey: string; client: C } | null = null;
  return ({ apiKey, onUserKey }) => {
    if (onUserKey) return create({ apiKey, ...SDK_CLIENT_OPTIONS });
    if (server?.apiKey !== apiKey) {
      server = { apiKey, client: create({ apiKey, ...SDK_CLIENT_OPTIONS }) };
    }
    return server.client;
  };
}

const anthropicClient = sdkClient((options) => new Anthropic(options));
const groqClient = sdkClient((options) => new Groq(options));
// Not warming: a client is created just before its first request, so that's a
// wasted extra request (one per call on a user's key).
const cerebrasClient = sdkClient(
  (options) => new Cerebras({ ...options, warmTCPConnection: false })
);

/**
 * Options for a single-turn chat completion.
 */
export interface ChatCompletionOptions {
  /** Optional system prompt. */
  system?: string;
  /** The user message. */
  userPrompt: string;
  /** Output token cap (reasoning models spend part of this on reasoning). */
  maxTokens: number;
  /**
   * Request a JSON-object response. Throws for a provider that can't give one
   * (see {@link TextProviderAdapter.jsonObject}).
   */
  jsonObject?: boolean;
  /** Sampling temperature. Ignored for Anthropic. */
  temperature?: number;
  /**
   * Reasoning effort for reasoning models. Ignored for Anthropic, and only
   * sent to models that accept the parameter (see
   * {@link supportsReasoningEffort}).
   */
  reasoningEffort?: "low" | "medium" | "high";
}

/**
 * Whether a provider-native model ID gets the OpenAI-style `reasoning_effort`
 * low/medium/high parameter. Only the gpt-oss family does: on Groq and
 * Cerebras other models (Llama, Qwen, ...) return `400 reasoning_effort is not
 * supported with this model`, and on OpenRouter it would switch on (billed)
 * extended thinking for Claude, Gemini, etc.
 */
export function supportsReasoningEffort(model: string): boolean {
  return model.toLowerCase().includes("gpt-oss");
}

/** How a text provider call failed (see {@link ProviderFailure}). */
export type TextGenerationFailure = ProviderFailure;

/** A failed {@link generateChatCompletion}; the provider's error is the `cause`. */
export class TextGenerationError extends Error {
  /** What the provider said, without the SDK's decoration, for showing the user. */
  readonly providerMessage: string;

  constructor(
    readonly provider: TextAiProvider,
    readonly failure: TextGenerationFailure,
    /**
     * Whether the user's own key made the call. When it didn't, the message
     * may describe the operator's account and must not reach the user.
     */
    readonly usedUserKey: boolean,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.providerMessage = providerMessageOf(cause) ?? this.message;
  }
}

const SDKS = [Anthropic, Groq, Cerebras];

function isConnectionError(error: unknown): boolean {
  // OpenRouter is plain fetch.
  return (
    SDKS.some((sdk) => error instanceof sdk.APIConnectionError) || isFetchConnectionError(error)
  );
}

/** The string at `path` in `value`, if there is one. */
function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current ? current : undefined;
}

/**
 * The provider's own explanation of a failure. An SDK error's message is its
 * status plus the JSON body; the explanation is in that body, at `error.message`
 * (Anthropic, and the OpenAI-shaped Groq and Cerebras) or `message`.
 */
function providerMessageOf(error: unknown): string | undefined {
  if (error instanceof OpenRouterChatError) return error.providerMessage;
  if (!SDKS.some((sdk) => error instanceof sdk.APIError)) return undefined;
  const body = (error as { error?: unknown }).error;
  return stringAt(body, "error", "message") ?? stringAt(body, "message");
}

/** The HTTP status a provider answered a failed request with, if it answered. */
function providerStatusOf(error: unknown): number | undefined {
  const status =
    error !== null && typeof error === "object" && "status" in error ? error.status : undefined;
  return typeof status === "number" ? status : undefined;
}

export function classifyTextGenerationError(error: unknown): TextGenerationFailure {
  if (isConnectionError(error)) return "busy";
  const status = providerStatusOf(error);
  return status === undefined ? "failed" : classifyProviderStatus(status);
}

/**
 * Runs a single-turn chat completion on the referenced model and returns the
 * response text (empty string if the model produced no text — callers decide
 * how to handle that).
 *
 * @throws Error if the provider is not configured, the model isn't allowed
 *   on the server's key, or the provider can't do what's asked
 * @throws TextGenerationError if the provider call fails
 */
export async function generateChatCompletion(
  ref: ModelRef,
  keys: AiProviderKeys | undefined,
  options: ChatCompletionOptions
): Promise<string> {
  const provider = ref.provider;
  if (!isTextAiProvider(provider)) {
    throw new Error(`${aiProviderName(provider)} is only used for cloud voices`);
  }
  if (keys?.[provider] === UNREADABLE_API_KEY) {
    throw new UnreadableApiKeyError(provider);
  }
  const apiKey = getProviderApiKey(provider, keys);
  if (!apiKey) {
    throw new Error(`${aiProviderName(provider)} API key not configured`);
  }
  const modelRef = formatModelRef(provider, ref.model);
  if (!(await isTextModelAllowed(modelRef, keys))) {
    throw new Error(`${modelRef} isn't allowed on the server's ${aiProviderName(provider)} key`);
  }
  const adapter = TEXT_PROVIDER_ADAPTERS[provider];
  if (options.jsonObject && !adapter.jsonObject) {
    throw new Error(`JSON-object responses are not supported for ${aiProviderName(provider)}`);
  }
  const onUserKey = isOnUserKey(provider, keys);
  try {
    return await adapter.complete({ apiKey, onUserKey }, ref.model, {
      ...options,
      reasoningEffort: supportsReasoningEffort(ref.model) ? options.reasoningEffort : undefined,
    });
  } catch (error) {
    throw new TextGenerationError(provider, classifyTextGenerationError(error), onUserKey, error);
  }
}

/**
 * A selectable model from a configured provider.
 */
export interface AiModel {
  /** Provider-qualified reference (`provider:model`) — the stored value. */
  id: string;
  displayName: string;
  provider: TextAiProvider;
  /** Only reported by some providers. */
  contextLength?: number;
  /** USD per million input/output tokens, when the provider reports prices. */
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
}

/**
 * Capabilities a feature needs from a model; models lacking them are hidden
 * from that feature's picker.
 */
export interface ModelRequirements {
  /** The model must support JSON-object responses. */
  jsonObject?: boolean;
}

/** A text provider's chat completions and model catalog. */
interface TextProviderAdapter {
  /**
   * Whether the provider can be asked for a JSON-object response at all.
   * One that can lists only the models able to give one when that's required.
   */
  jsonObject: boolean;
  /** The response text ("" for none) to `options` from `model` (provider-native). */
  complete(call: ProviderCall, model: string, options: ChatCompletionOptions): Promise<string>;
  listModels(call: ProviderCall, requirements: ModelRequirements): Promise<AiModel[]>;
}

/** A chat completion request to the OpenAI-compatible SDKs (Groq, Cerebras). */
function openAiCompatibleRequest(model: string, options: ChatCompletionOptions) {
  return {
    model,
    max_completion_tokens: options.maxTokens,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    ...(options.jsonObject ? { response_format: { type: "json_object" as const } } : {}),
    messages: [
      ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
      { role: "user" as const, content: options.userPrompt },
    ],
  };
}

const TEXT_PROVIDER_ADAPTERS: Record<TextAiProvider, TextProviderAdapter> = {
  anthropic: {
    jsonObject: false,
    complete: async (call, model, options) => {
      const response = await anthropicClient(call).messages.create({
        model,
        max_tokens: options.maxTokens,
        ...(options.system ? { system: options.system } : {}),
        messages: [{ role: "user", content: options.userPrompt }],
      });
      const textContent = response.content.find((block) => block.type === "text");
      return textContent?.type === "text" ? textContent.text : "";
    },
    listModels: async (call) => {
      const models: { id: string; displayName: string }[] = [];
      for await (const model of anthropicClient(call).models.list({ limit: 100 })) {
        models.push({ id: model.id, displayName: model.display_name });
      }
      return filterToLatestClaudeGeneration(simplifyModelIds(models)).map((model) => ({
        id: formatModelRef("anthropic", model.id),
        displayName: model.displayName,
        provider: "anthropic" as const,
      }));
    },
  },
  // Groq's and Cerebras' listings don't say which models do JSON mode; every
  // chat model they serve does.
  groq: {
    jsonObject: true,
    complete: async (call, model, options) => {
      const response = await groqClient(call).chat.completions.create(
        openAiCompatibleRequest(model, options)
      );
      return response.choices[0]?.message?.content ?? "";
    },
    listModels: async (call) => toChatModels("groq", (await groqClient(call).models.list()).data),
  },
  cerebras: {
    jsonObject: true,
    complete: async (call, model, options) => {
      const response = await cerebrasClient(call).chat.completions.create(
        openAiCompatibleRequest(model, options)
      );
      // The SDK's non-streaming return type is a union that includes the error
      // and chunk shapes; narrow to the completed-response choice, which is the
      // only one carrying `message` (chunks carry `delta` instead).
      const choice = "choices" in response ? response.choices?.[0] : undefined;
      return choice && "message" in choice ? (choice.message.content ?? "") : "";
    },
    listModels: async (call) =>
      toChatModels("cerebras", (await cerebrasClient(call).models.list()).data),
  },
  openrouter: {
    jsonObject: true,
    complete: ({ apiKey, onUserKey }, model, options) =>
      openRouterChatCompletion(
        apiKey,
        model,
        options,
        onUserKey ? null : serverKeyTokenPriceCaps(formatModelRef("openrouter", model)),
        TEXT_REQUEST_BUDGET_MS
      ),
    listModels: async (_call, requirements) =>
      (await listOpenRouterModels("text"))
        .filter((model) => isUsableOpenRouterModel(model, requirements))
        .map((model) => ({
          id: formatModelRef("openrouter", model.id),
          displayName: model.name,
          provider: "openrouter" as const,
          contextLength: model.context_length ?? undefined,
          inputPricePerMillion: pricePerMillionUnits(model.pricing?.prompt),
          outputPricePerMillion: pricePerMillionUnits(model.pricing?.completion),
        }))
        .sort(byDisplayName),
  },
};

function byDisplayName(a: AiModel, b: AiModel): number {
  return a.displayName.localeCompare(b.displayName);
}

/**
 * Strips date suffixes from versioned Anthropic model IDs, keeping only the
 * first (newest) version of each model.
 *
 * The Anthropic API returns versioned IDs like "claude-sonnet-4-5-20250929"
 * but accepts shorter aliases like "claude-sonnet-4-5". Since the API returns
 * models newest-first, we keep the first occurrence of each alias and drop
 * subsequent versions.
 */
export function simplifyModelIds(
  models: { id: string; displayName: string }[]
): { id: string; displayName: string }[] {
  const seen = new Set<string>();
  const result: { id: string; displayName: string }[] = [];

  for (const model of models) {
    const match = model.id.match(/^(.+)-\d{8}$/);
    const alias = match ? match[1] : model.id;

    if (!seen.has(alias)) {
      seen.add(alias);
      result.push({ id: alias, displayName: model.displayName });
    }
  }

  return result;
}

/**
 * Groq's model list includes audio (whisper/TTS) and moderation models that
 * can't do chat completions; hide them from the pickers. TTS families don't all
 * spell "tts" in their IDs (Groq exposes Orpheus TTS as `canopylabs/orpheus-*`),
 * so match those families by name too.
 */
export function isChatModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    !lower.includes("whisper") &&
    !lower.includes("tts") &&
    !lower.includes("guard") &&
    !lower.includes("canopylabs") &&
    !lower.includes("orpheus")
  );
}

/**
 * Minimum context window (in tokens) for a model to appear in the summarization
 * and narration pickers. Summarization feeds up to ~12k tokens of article text
 * plus the prompt and reserves several thousand output/reasoning tokens, so
 * short-context models (e.g. Groq's 8k-context Gemma/older-Llama or small Qwen
 * builds) can't reasonably summarize a full article. Models whose context
 * window is unknown (Cerebras omits the field) are kept.
 */
const MIN_CONTEXT_WINDOW = 32768;

/**
 * Reads the optional `context_window` field the Groq models API returns. The
 * provider SDK types don't expose it, so we read it defensively; Cerebras omits
 * it entirely (returns `undefined`).
 */
function contextWindowOf(model: unknown): number | undefined {
  const value = (model as { context_window?: unknown }).context_window;
  return typeof value === "number" ? value : undefined;
}

/**
 * Whether a Groq/Cerebras model is usable for summarization/narration: it must
 * be a chat model and, when the provider reports a context window, have enough
 * room to summarize a full article.
 */
function isUsableChatModel(model: { id: string }): boolean {
  if (!isChatModelId(model.id)) {
    return false;
  }
  const contextWindow = contextWindowOf(model);
  return contextWindow === undefined || contextWindow >= MIN_CONTEXT_WINDOW;
}

/** A Groq or Cerebras model listing's usable chat models, named by id. */
function toChatModels(provider: "groq" | "cerebras", models: { id: string }[]): AiModel[] {
  return models
    .filter(isUsableChatModel)
    .map((model) => ({
      id: formatModelRef(provider, model.id),
      displayName: model.id,
      provider,
    }))
    .sort(byDisplayName);
}

/**
 * Whether an OpenRouter model can serve summarization/narration: text-only
 * output (drops image/audio generators), a long enough context, and
 * synchronous (`:batch` variants only work through the async batch API).
 */
export function isUsableOpenRouterModel(
  model: OpenRouterModel,
  requirements: ModelRequirements = {}
): boolean {
  const outputs = model.architecture?.output_modalities ?? ["text"];
  if (outputs.length !== 1 || outputs[0] !== "text") return false;
  if (model.id.endsWith(":batch")) return false;
  if ((model.context_length ?? 0) < MIN_CONTEXT_WINDOW) return false;
  if (pricePerMillionUnits(model.pricing?.prompt) === undefined) return false;
  if (requirements.jsonObject && !model.supported_parameters?.includes("response_format")) {
    return false;
  }
  return true;
}

/** Claude model families we surface, one (newest) model per family. */
const CLAUDE_FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

/**
 * Filters Anthropic models to the newest generation — the latest Opus, Sonnet,
 * Haiku, and Fable — dropping older versions of each family. The Anthropic API
 * returns models newest-first, so the first model seen for a family is its
 * newest. Models that don't match a known family are kept (so a new family
 * isn't accidentally hidden).
 */
export function filterToLatestClaudeGeneration(
  models: { id: string; displayName: string }[]
): { id: string; displayName: string }[] {
  const seenFamilies = new Set<string>();
  const result: { id: string; displayName: string }[] = [];

  for (const model of models) {
    const family = CLAUDE_FAMILIES.find((f) => model.id.toLowerCase().includes(f));
    if (!family) {
      result.push(model);
      continue;
    }
    if (!seenFamilies.has(family)) {
      seenFamilies.add(family);
      result.push(model);
    }
  }

  return result;
}

/**
 * Lists selectable text models across the requested providers (default: all),
 * skipping providers with no usable key (none, or the user's can't be read)
 * and, when JSON-object responses are required, those that can't give one.
 * A provider whose listing fails is logged and skipped so the others still
 * show up.
 */
export async function listAllModels(
  keys?: AiProviderKeys,
  providers: readonly TextAiProvider[] = TEXT_AI_PROVIDERS,
  requirements: ModelRequirements = {}
): Promise<AiModel[]> {
  const results = await Promise.all(
    providers.map(async (provider) => {
      const adapter = TEXT_PROVIDER_ADAPTERS[provider];
      const apiKey = getProviderApiKey(provider, keys);
      if (!apiKey || (requirements.jsonObject && !adapter.jsonObject)) return [];
      try {
        return await adapter.listModels(
          { apiKey, onUserKey: isOnUserKey(provider, keys) },
          requirements
        );
      } catch (error) {
        logger.error("Failed to list AI models", {
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    })
  );
  return results.flat();
}
