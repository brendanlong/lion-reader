/**
 * Generic AI provider layer.
 *
 * Wraps the Anthropic, Groq, and Cerebras SDKs and the OpenRouter HTTP API
 * behind one interface so features (summarization, narration preprocessing)
 * can run on any configured provider. Per-user API keys override the
 * server-wide env keys (`ANTHROPIC_API_KEY`, `GROQ_API_KEY`,
 * `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`); a provider is "available" when
 * either is set.
 */

import Anthropic from "@anthropic-ai/sdk";
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import Groq from "groq-sdk";
import { logger } from "@/lib/logger";
import {
  AI_PROVIDERS,
  formatModelRef,
  normalizeModelRef,
  parseModelRef,
  type AiProvider,
  type ModelRef,
} from "@/lib/ai/model-ref";
import {
  listOpenRouterModels,
  openRouterChatCompletion,
  pricePerMillionUnits,
  type OpenRouterModel,
} from "@/server/services/openrouter";

/**
 * Per-user provider API keys, matching the shape returned by
 * `getUserApiKeys`. Null/undefined entries fall back to the server env key.
 */
export interface AiProviderKeys {
  anthropicApiKey?: string | null;
  groqApiKey?: string | null;
  cerebrasApiKey?: string | null;
  openrouterApiKey?: string | null;
}

export const AI_PROVIDER_ENV_KEYS: Record<AiProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

function userKeyFor(provider: AiProvider, keys?: AiProviderKeys): string | null {
  switch (provider) {
    case "anthropic":
      return keys?.anthropicApiKey ?? null;
    case "groq":
      return keys?.groqApiKey ?? null;
    case "cerebras":
      return keys?.cerebrasApiKey ?? null;
    case "openrouter":
      return keys?.openrouterApiKey ?? null;
  }
}

/** The user's key for the provider, else the server's, else null. */
export function getProviderApiKey(provider: AiProvider, keys?: AiProviderKeys): string | null {
  return userKeyFor(provider, keys) ?? process.env[AI_PROVIDER_ENV_KEYS[provider]] ?? null;
}

/**
 * Checks whether a provider can be used (user key or server env key set).
 */
export function isProviderAvailable(provider: AiProvider, keys?: AiProviderKeys): boolean {
  return !!userKeyFor(provider, keys) || !!process.env[AI_PROVIDER_ENV_KEYS[provider]];
}

/**
 * OpenRouter's catalog includes models costing 100x our defaults, so when a
 * request would be billed to the server's key (the user has no OpenRouter key
 * of their own) only the given models may be listed or used.
 */
export function isModelAllowed(
  modelRef: string,
  keys: AiProviderKeys | undefined,
  allowedWithServerKey: readonly string[]
): boolean {
  const { provider } = parseModelRef(modelRef);
  if (provider !== "openrouter" || userKeyFor(provider, keys)) {
    return true;
  }
  return allowedWithServerKey.includes(normalizeModelRef(modelRef));
}

/**
 * Lists the providers that can currently be used, in declaration order.
 */
export function getAvailableProviders(keys?: AiProviderKeys): AiProvider[] {
  return AI_PROVIDERS.filter((provider) => isProviderAvailable(provider, keys));
}

// Global clients for the server-wide env keys, created lazily. Clients for
// per-user keys are always created fresh (never cached).
let globalAnthropicClient: Anthropic | null = null;
let globalGroqClient: Groq | null = null;
let globalCerebrasClient: Cerebras | null = null;

function getAnthropicClient(keys?: AiProviderKeys): Anthropic | null {
  const userKey = userKeyFor("anthropic", keys);
  if (userKey) {
    return new Anthropic({ apiKey: userKey });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return null;
  }
  globalAnthropicClient ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return globalAnthropicClient;
}

function getGroqClient(keys?: AiProviderKeys): Groq | null {
  const userKey = userKeyFor("groq", keys);
  if (userKey) {
    return new Groq({ apiKey: userKey });
  }
  if (!process.env.GROQ_API_KEY) {
    return null;
  }
  globalGroqClient ??= new Groq({ apiKey: process.env.GROQ_API_KEY });
  return globalGroqClient;
}

function getCerebrasClient(keys?: AiProviderKeys): Cerebras | null {
  const userKey = userKeyFor("cerebras", keys);
  if (userKey) {
    return new Cerebras({ apiKey: userKey });
  }
  if (!process.env.CEREBRAS_API_KEY) {
    return null;
  }
  globalCerebrasClient ??= new Cerebras({ apiKey: process.env.CEREBRAS_API_KEY });
  return globalCerebrasClient;
}

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
   * Request a JSON-object response. Only supported by the OpenAI-compatible
   * providers (Groq, Cerebras, OpenRouter); throws for Anthropic.
   */
  jsonObject?: boolean;
  /** Sampling temperature. Ignored for Anthropic. */
  temperature?: number;
  /**
   * Reasoning effort for reasoning models. Ignored for Anthropic, and only
   * sent to models that accept the parameter (see
   * {@link supportsReasoningEffort}) — Groq/Cerebras reject it with a 400 on
   * non-reasoning models like Llama.
   */
  reasoningEffort?: "low" | "medium" | "high";
}

/**
 * Whether a provider-native model ID accepts the OpenAI-style
 * `reasoning_effort` low/medium/high parameter. Currently only the gpt-oss
 * family does on Groq and Cerebras; other models (Llama, Qwen, ...) return
 * `400 reasoning_effort is not supported with this model`.
 */
export function supportsReasoningEffort(model: string): boolean {
  return model.toLowerCase().includes("gpt-oss");
}

/**
 * Runs a single-turn chat completion on the referenced model and returns the
 * response text (empty string if the model produced no text — callers decide
 * how to handle that).
 *
 * @throws Error if the provider is not configured
 */
export async function generateChatCompletion(
  ref: ModelRef,
  keys: AiProviderKeys | undefined,
  options: ChatCompletionOptions
): Promise<string> {
  switch (ref.provider) {
    case "anthropic": {
      if (options.jsonObject) {
        throw new Error("JSON-object responses are not supported for Anthropic models");
      }
      const client = getAnthropicClient(keys);
      if (!client) {
        throw new Error("Anthropic API key not configured");
      }
      const response = await client.messages.create({
        model: ref.model,
        max_tokens: options.maxTokens,
        ...(options.system ? { system: options.system } : {}),
        messages: [{ role: "user", content: options.userPrompt }],
      });
      const textContent = response.content.find((block) => block.type === "text");
      return textContent?.type === "text" ? textContent.text : "";
    }
    case "groq": {
      const client = getGroqClient(keys);
      if (!client) {
        throw new Error("Groq API key not configured");
      }
      const response = await client.chat.completions.create({
        model: ref.model,
        max_completion_tokens: options.maxTokens,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.reasoningEffort && supportsReasoningEffort(ref.model)
          ? { reasoning_effort: options.reasoningEffort }
          : {}),
        ...(options.jsonObject ? { response_format: { type: "json_object" as const } } : {}),
        messages: [
          ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
          { role: "user" as const, content: options.userPrompt },
        ],
      });
      return response.choices[0]?.message?.content ?? "";
    }
    case "cerebras": {
      const client = getCerebrasClient(keys);
      if (!client) {
        throw new Error("Cerebras API key not configured");
      }
      const response = await client.chat.completions.create({
        model: ref.model,
        max_completion_tokens: options.maxTokens,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.reasoningEffort && supportsReasoningEffort(ref.model)
          ? { reasoning_effort: options.reasoningEffort }
          : {}),
        ...(options.jsonObject ? { response_format: { type: "json_object" as const } } : {}),
        messages: [
          ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
          { role: "user" as const, content: options.userPrompt },
        ],
      });
      // The SDK's non-streaming return type is a union that includes the error
      // and chunk shapes; narrow to the completed-response choice, which is the
      // only one carrying `message` (chunks carry `delta` instead).
      const choice = "choices" in response ? response.choices?.[0] : undefined;
      return choice && "message" in choice ? (choice.message.content ?? "") : "";
    }
    case "openrouter": {
      const apiKey = getProviderApiKey("openrouter", keys);
      if (!apiKey) {
        throw new Error("OpenRouter API key not configured");
      }
      // Match Groq/Cerebras: only gpt-oss gets a reasoning effort. On OpenRouter
      // it would otherwise switch on (billed) extended thinking for Claude,
      // Gemini, etc.
      return openRouterChatCompletion(apiKey, ref.model, {
        ...options,
        reasoningEffort: supportsReasoningEffort(ref.model) ? options.reasoningEffort : undefined,
      });
    }
  }
}

/**
 * A selectable model from a configured provider.
 */
export interface AiModel {
  /** Provider-qualified reference (`provider:model`) — the stored value. */
  id: string;
  displayName: string;
  provider: AiProvider;
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

async function listProviderModels(
  provider: AiProvider,
  keys: AiProviderKeys | undefined,
  requirements: ModelRequirements
): Promise<AiModel[]> {
  switch (provider) {
    case "anthropic": {
      const client = getAnthropicClient(keys);
      if (!client) return [];
      const models: { id: string; displayName: string }[] = [];
      // Fetch all models using auto-pagination
      for await (const model of client.models.list({ limit: 100 })) {
        models.push({ id: model.id, displayName: model.display_name });
      }
      return filterToLatestClaudeGeneration(simplifyModelIds(models)).map((model) => ({
        id: formatModelRef("anthropic", model.id),
        displayName: model.displayName,
        provider: "anthropic" as const,
      }));
    }
    case "groq": {
      const client = getGroqClient(keys);
      if (!client) return [];
      const response = await client.models.list();
      return response.data
        .filter((model) => isUsableChatModel(model))
        .map((model) => ({
          id: formatModelRef("groq", model.id),
          displayName: model.id,
          provider: "groq" as const,
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
    case "cerebras": {
      const client = getCerebrasClient(keys);
      if (!client) return [];
      const response = await client.models.list();
      return response.data
        .filter((model) => isUsableChatModel(model))
        .map((model) => ({
          id: formatModelRef("cerebras", model.id),
          displayName: model.id,
          provider: "cerebras" as const,
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
    case "openrouter": {
      const models = await listOpenRouterModels("text");
      return models
        .filter((model) => isUsableOpenRouterModel(model, requirements))
        .map((model) => ({
          id: formatModelRef("openrouter", model.id),
          displayName: model.name,
          provider: "openrouter" as const,
          contextLength: model.context_length ?? undefined,
          inputPricePerMillion: pricePerMillionUnits(model.pricing?.prompt),
          outputPricePerMillion: pricePerMillionUnits(model.pricing?.completion),
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
  }
}

/**
 * Lists selectable models across the requested providers (default: all),
 * skipping providers with no key configured. A provider whose listing fails
 * is logged and skipped so the others still show up.
 */
export async function listAllModels(
  keys?: AiProviderKeys,
  providers: readonly AiProvider[] = AI_PROVIDERS,
  requirements: ModelRequirements = {}
): Promise<AiModel[]> {
  const results = await Promise.all(
    providers
      .filter((provider) => isProviderAvailable(provider, keys))
      .map(async (provider) => {
        try {
          return await listProviderModels(provider, keys, requirements);
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
