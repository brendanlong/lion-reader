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

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 120_000;
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

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
});

export type OpenRouterModel = z.infer<typeof openRouterModelSchema>;

const chatCompletionResponseSchema = z.object({
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

async function errorFromResponse(response: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") {
      detail = `: ${body.error.message.slice(0, 500)}`;
    }
  } catch {
    // Non-JSON error body; the status is enough.
  }
  return new Error(`OpenRouter request failed with status ${response.status}${detail}`);
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
  supportedParameters: readonly string[]
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
    },
  };
}

export async function openRouterChatCompletion(
  apiKey: string,
  model: string,
  options: ChatCompletionOptions
): Promise<string> {
  // Without the catalog, fall back to sending no optional parameters.
  const catalog = await listOpenRouterModels("text").catch(() => []);
  const catalogEntry = catalog.find((entry) => entry.id === model);
  const response = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
    method: "POST",
    headers: { ...headers(apiKey), "Content-Type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify(
      buildChatCompletionBody(model, options, catalogEntry?.supported_parameters ?? [])
    ),
  });
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  const parsed = chatCompletionResponseSchema.parse(await response.json());
  return parsed.choices?.[0]?.message?.content ?? "";
}

const modelCache = new Map<string, { fetchedAt: number; models: OpenRouterModel[] }>();

/**
 * Lists OpenRouter models producing the given output modality. Entries that
 * don't match the expected shape are skipped rather than failing the list.
 */
export async function listOpenRouterModels(outputModality: "text"): Promise<OpenRouterModel[]> {
  const cached = modelCache.get(outputModality);
  if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
    return cached.models;
  }

  const response = await fetch(
    `${OPENROUTER_API_URL}/models?output_modalities=${encodeURIComponent(outputModality)}`,
    { headers: headers(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  const body = z.object({ data: z.array(z.unknown()) }).parse(await response.json());
  const models = body.data.flatMap((entry) => {
    const result = openRouterModelSchema.safeParse(entry);
    return result.success ? [result.data] : [];
  });

  modelCache.set(outputModality, { fetchedAt: Date.now(), models });
  return models;
}

/**
 * Converts OpenRouter's per-token USD price string to USD per million tokens.
 * Returns undefined for missing prices and for the negative sentinel used by
 * routers whose price depends on the model they pick.
 */
export function pricePerMillionTokens(price: string | null | undefined): number | undefined {
  if (price == null) return undefined;
  const value = Number(price);
  // toPrecision strips float noise like 0.7999999999999999.
  return Number.isFinite(value) && value >= 0
    ? Number((value * 1_000_000).toPrecision(6))
    : undefined;
}
