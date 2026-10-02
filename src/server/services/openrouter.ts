/**
 * OpenRouter client (OpenAI-compatible HTTP API, no SDK).
 *
 * The model catalog is public and identical for every key, so it is fetched
 * without a key and cached in-process per output modality.
 */

import { z } from "zod";
import { USER_AGENT } from "@/server/http/user-agent";
import { appUrl } from "@/server/config/env";
import type { ChatCompletionOptions } from "@/server/services/ai-providers";
import type { ModelPrice } from "@/server/services/server-key-models";
import type { PcmStream } from "@/server/services/speech-encoding";
import { providerError } from "@/server/services/provider-errors";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 120_000;
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const MODEL_CACHE_RETRY_MS = 60 * 1000;

const openRouterModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  context_length: z.number().nullish(),
  architecture: z
    .object({
      output_modalities: z.array(z.string()).nullish(),
    })
    .nullish(),
  pricing: z
    .object({
      prompt: z.string().nullish(),
      completion: z.string().nullish(),
    })
    .nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  supported_voices: z.array(z.string()).nullish(),
});

export type OpenRouterModel = z.infer<typeof openRouterModelSchema>;

/** OpenRouter's error body, which can also arrive in a 200 for an upstream failure. */
const errorSchema = z
  .object({ message: z.string().nullish(), code: z.union([z.number(), z.string()]).nullish() })
  .nullish();

const chatCompletionResponseSchema = z.object({
  error: errorSchema,
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullish() }).nullish(),
      })
    )
    .nullish(),
});

function headers(apiKey?: string): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    // OpenRouter app attribution (shown on their dashboards and rankings).
    "HTTP-Referer": appUrl,
    "X-OpenRouter-Title": "Lion Reader",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

/**
 * Builds the chat completion request body. Optional parameters are only sent
 * when the model's catalog entry lists them: JSON mode sets
 * `require_parameters`, which restricts routing to hosts supporting *every*
 * parameter sent, so an unsupported extra would leave no host at all.
 */
export function buildChatCompletionBody(
  model: string,
  options: ChatCompletionOptions,
  supportedParameters: readonly string[],
  priceCaps: TokenPriceCaps | null = null
): Record<string, unknown> {
  const supports = (parameter: string) => supportedParameters.includes(parameter);
  return {
    model,
    messages: [
      ...(options.system ? [{ role: "system", content: options.system }] : []),
      { role: "user", content: options.userPrompt },
    ],
    ...(supports("max_tokens") ? { max_tokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined && supports("temperature")
      ? { temperature: options.temperature }
      : {}),
    ...(options.reasoningEffort && supports("reasoning")
      ? { reasoning: { effort: options.reasoningEffort } }
      : {}),
    ...(options.jsonObject ? { response_format: { type: "json_object" } } : {}),
    provider: {
      // Every caller is interactive, so prefer the fastest host.
      sort: "throughput",
      // Only route to hosts that honor JSON mode rather than having the
      // parameter silently dropped.
      ...(options.jsonObject ? { require_parameters: true } : {}),
      ...(priceCaps
        ? {
            max_price: { prompt: priceCaps.maxInputPrice, completion: priceCaps.maxOutputPrice },
          }
        : {}),
    },
  };
}

/** USD per million tokens; hosts charging more are skipped. */
interface TokenPriceCaps {
  maxInputPrice?: number;
  maxOutputPrice?: number;
}

/**
 * A failed chat completion: the status OpenRouter answered with (for an
 * upstream failure in a 200 body, the code it reports for it) and its message.
 */
export class OpenRouterChatError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly providerMessage: string | undefined
  ) {
    super(
      `OpenRouter request failed${status ? ` with status ${status}` : ""}: ${providerMessage ?? "unknown error"}`
    );
  }
}

function chatError(error: z.infer<typeof errorSchema>, status?: number): OpenRouterChatError {
  const code = typeof error?.code === "number" ? error.code : undefined;
  return new OpenRouterChatError(status ?? code, error?.message?.slice(0, 500) ?? undefined);
}

/**
 * The text of a chat completion answered with `status` and `body`.
 *
 * @throws OpenRouterChatError for a failure, whether in the status or the body
 */
export function chatCompletionText(status: number, body: unknown): string {
  if (status < 200 || status >= 300) {
    const parsed = z.object({ error: errorSchema }).safeParse(body);
    // The answer's own status wins over a code in its body.
    throw chatError(parsed.success ? parsed.data.error : null, status);
  }
  const parsed = chatCompletionResponseSchema.parse(body);
  if (parsed.error) {
    throw chatError(parsed.error);
  }
  return parsed.choices?.[0]?.message?.content ?? "";
}

export async function openRouterChatCompletion(
  apiKey: string,
  model: string,
  options: ChatCompletionOptions,
  priceCaps: TokenPriceCaps | null = null
): Promise<string> {
  // Without the catalog, fall back to sending no optional parameters.
  const catalog = await listOpenRouterModels("text").catch(() => []);
  const catalogEntry = catalog.find((entry) => entry.id === model);
  const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
    method: "POST",
    headers: { ...headers(apiKey), "Content-Type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify(
      buildChatCompletionBody(model, options, catalogEntry?.supported_parameters ?? [], priceCaps)
    ),
  });
  return chatCompletionText(response.status, await response.json().catch(() => null));
}

/** A text model's price, or none if the catalog can't be fetched or lacks it. */
export async function openRouterTextModelPrice(model: string): Promise<ModelPrice> {
  const catalog = await listOpenRouterModels("text").catch(() => []);
  const entry = catalog.find((candidate) => candidate.id === model);
  return {
    inputPricePerMillion: pricePerMillionUnits(entry?.pricing?.prompt),
    outputPricePerMillion: pricePerMillionUnits(entry?.pricing?.completion),
  };
}

const modelCache = new Map<string, { expiresAt: number; models: OpenRouterModel[] }>();
const refreshes = new Map<string, Promise<OpenRouterModel[]>>();

/**
 * Lists OpenRouter models producing the given output modality. Entries that
 * don't match the expected shape are skipped rather than failing the list. If
 * a refresh fails, the stale list is served and the refresh retried a minute
 * later rather than on every call.
 */
export async function listOpenRouterModels(
  outputModality: "text" | "speech"
): Promise<OpenRouterModel[]> {
  const cached = modelCache.get(outputModality);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.models;
  }
  // Concurrent callers (e.g. parallel speech prefetches) share one refresh.
  let refresh = refreshes.get(outputModality);
  if (!refresh) {
    refresh = (async () => {
      try {
        const models = await fetchOpenRouterModels(outputModality);
        modelCache.set(outputModality, { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models });
        return models;
      } catch (error) {
        if (!cached) throw error;
        cached.expiresAt = Date.now() + MODEL_CACHE_RETRY_MS;
        return cached.models;
      } finally {
        refreshes.delete(outputModality);
      }
    })();
    refreshes.set(outputModality, refresh);
  }
  return refresh;
}

async function fetchOpenRouterModels(outputModality: string): Promise<OpenRouterModel[]> {
  const response = await fetch(
    `${OPENROUTER_API_URL}/models?output_modalities=${encodeURIComponent(outputModality)}`,
    { headers: headers(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
  if (!response.ok) {
    throw await providerError("OpenRouter", response);
  }
  const body = z.object({ data: z.array(z.unknown()) }).parse(await response.json());
  return body.data.flatMap((entry) => {
    const result = openRouterModelSchema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
}

/**
 * Speech as PCM via the OpenAI-compatible speech endpoint, streamed as it's
 * generated. Its format is in the content type (`audio/pcm;rate=24000;channels=1`).
 */
export async function openRouterSpeech(
  apiKey: string,
  model: string,
  voice: string,
  input: string,
  signal: AbortSignal
): Promise<PcmStream> {
  const response = await fetch(`${OPENROUTER_API_URL}/audio/speech`, {
    method: "POST",
    headers: { ...headers(apiKey), "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      voice,
      input,
      response_format: "pcm",
      // Otherwise it's sent once it's all generated.
      stream: true,
      provider: { sort: "latency" },
    }),
  });
  if (!response.ok || !response.body) {
    throw await providerError("OpenRouter", response);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const param = (name: string) => Number(new RegExp(`${name}=(\\d+)`).exec(contentType)?.[1]);
  const sampleRate = param("rate");
  if (!contentType.startsWith("audio/pcm") || !sampleRate) {
    await response.body.cancel();
    throw new Error(`OpenRouter speech in an unknown format: ${contentType}`);
  }
  return { sampleRate, channels: param("channels") || 1, data: response.body };
}

/**
 * Converts OpenRouter's per-unit USD price string (per token, or per character
 * for speech models) to USD per million units.
 * Returns undefined for missing prices and for the negative sentinel used by
 * routers whose price depends on the model they pick.
 */
export function pricePerMillionUnits(price: string | null | undefined): number | undefined {
  if (price == null) return undefined;
  const value = Number(price);
  // toPrecision strips float noise like 0.7999999999999999.
  return Number.isFinite(value) && value >= 0
    ? Number((value * 1_000_000).toPrecision(6))
    : undefined;
}
