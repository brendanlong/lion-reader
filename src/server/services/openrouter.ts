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
import { CatalogCache } from "@/server/services/catalog-cache";

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

const chatCompletionResponseSchema = z.object({
  // OpenRouter can report an upstream failure in a 200 body.
  error: z.object({ message: z.string().nullish() }).nullish(),
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
  if (!response.ok) {
    throw await providerError("OpenRouter", response);
  }
  const parsed = chatCompletionResponseSchema.parse(await response.json());
  if (parsed.error) {
    throw new Error(`OpenRouter request failed: ${parsed.error.message ?? "unknown error"}`);
  }
  return parsed.choices?.[0]?.message?.content ?? "";
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

const modelCache = new CatalogCache(fetchOpenRouterModels, {
  ttlMs: MODEL_CACHE_TTL_MS,
  retryMs: MODEL_CACHE_RETRY_MS,
});

/**
 * Lists OpenRouter models producing the given output modality. Entries that
 * don't match the expected shape are skipped rather than failing the list.
 */
export function listOpenRouterModels(
  outputModality: "text" | "speech"
): Promise<OpenRouterModel[]> {
  return modelCache.get(outputModality);
}

async function fetchOpenRouterModels(outputModality: string): Promise<OpenRouterModel[]> {
  const response = await fetch(
    `${OPENROUTER_API_URL}/models?output_modalities=${encodeURIComponent(outputModality)}`,
    { headers: headers(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
  if (!response.ok) {
    throw await providerError("OpenRouter", response, { keyed: false });
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
