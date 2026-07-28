/**
 * OpenRouter provider client.
 *
 * OpenRouter is an aggregator: one API key reaches models from every major lab,
 * so users don't have to sign up for each provider we'd otherwise integrate
 * one-by-one (issue #1416). It has no official SDK we want to depend on and its
 * API is OpenAI-shaped, so this is a thin `fetch` wrapper over the two
 * endpoints we need: chat completions and the model catalog.
 *
 * The endpoints are a fixed, first-party host — no user-influenced URLs — so
 * these calls don't go through `fetchWithSsrfProtection`.
 */

import { z } from "zod";
import { logger } from "@/lib/logger";
import { appUrl } from "@/server/config/env";
import { USER_AGENT } from "@/server/http/user-agent";
import { isChatModelId, MIN_CONTEXT_WINDOW } from "@/lib/ai/model-filters";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenRouter attributes requests to an app via these headers and shows it in
 * their public rankings. Sending them is optional but makes our traffic
 * identifiable to them the same way our User-Agent does to feed publishers.
 */
function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "HTTP-Referer": appUrl,
    "X-Title": "Lion Reader",
  };
}

/**
 * OpenRouter reports upstream failures two ways: a non-2xx status, and a 200
 * whose body carries an `error` object (when the failure happened after the
 * stream was opened). Both are parsed the same way so callers see one error
 * shape.
 */
const errorBodySchema = z.object({
  error: z.object({ message: z.string().optional(), code: z.unknown().optional() }).optional(),
});

function extractErrorMessage(body: unknown, fallback: string): string {
  const parsed = errorBodySchema.safeParse(body);
  return parsed.success ? (parsed.data.error?.message ?? fallback) : fallback;
}

const chatCompletionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish() }).optional() }))
    .optional(),
});

/**
 * Body of a single-turn OpenRouter chat completion. Mirrors the OpenAI schema;
 * only the fields our features use are modeled.
 */
export interface OpenRouterChatRequest {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  max_tokens: number;
  temperature?: number;
  reasoning_effort?: "low" | "medium" | "high";
  response_format?: { type: "json_object" };
}

/**
 * Runs a single-turn chat completion and returns the response text (empty
 * string when the model produced none).
 *
 * @throws Error if OpenRouter rejects the request or reports an upstream error
 */
export async function openRouterChatCompletion(
  apiKey: string,
  request: OpenRouterChatRequest
): Promise<string> {
  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: openRouterHeaders(apiKey),
    body: JSON.stringify(request),
  });

  // A non-JSON body (gateway HTML error page) must not mask the status code.
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `OpenRouter request failed (${response.status}): ${extractErrorMessage(
        body,
        response.statusText
      )}`
    );
  }

  const errorMessage = errorBodySchema.safeParse(body);
  if (errorMessage.success && errorMessage.data.error) {
    throw new Error(`OpenRouter request failed: ${extractErrorMessage(body, "unknown error")}`);
  }

  const parsed = chatCompletionSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("OpenRouter returned an unexpected chat completion response");
  }
  return parsed.data.choices?.[0]?.message?.content ?? "";
}

/**
 * A model from OpenRouter's catalog, narrowed to the fields we filter and
 * display on. Everything but `id` is optional so a catalog change can't make
 * the whole list fail to parse.
 */
const openRouterModelSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  context_length: z.number().nullish(),
  architecture: z
    .object({
      input_modalities: z.array(z.string()).nullish(),
      output_modalities: z.array(z.string()).nullish(),
    })
    .nullish(),
  supported_parameters: z.array(z.string()).nullish(),
});

export type OpenRouterModel = z.infer<typeof openRouterModelSchema>;

const modelsResponseSchema = z.object({ data: z.array(openRouterModelSchema) });

/**
 * Whether an OpenRouter model can back summarization/narration.
 *
 * OpenRouter lists ~370 models, including image- and audio-output models and
 * short-context builds, so the catalog needs real filtering before it reaches a
 * picker. An omitted modality or context window is treated as "fine" — those
 * filters shouldn't hide a model just because OpenRouter stopped reporting a
 * field.
 *
 * @param requireJsonObject - Keep only models that explicitly list
 *   `response_format` support. Narration preprocessing parses a JSON object out
 *   of the response, and a model that can't do that produces garbage rather
 *   than a clean failure, so this one filter is fail-closed.
 */
export function isUsableOpenRouterModel(
  model: OpenRouterModel,
  { requireJsonObject = false }: { requireJsonObject?: boolean } = {}
): boolean {
  if (!isChatModelId(model.id)) {
    return false;
  }
  // Text in and text out. A multimodal model that *also* accepts images or
  // emits audio is fine; one that can't take or produce text is not.
  const inputs = model.architecture?.input_modalities;
  const outputs = model.architecture?.output_modalities;
  if (inputs && !inputs.includes("text")) {
    return false;
  }
  if (outputs && !outputs.includes("text")) {
    return false;
  }
  if (typeof model.context_length === "number" && model.context_length < MIN_CONTEXT_WINDOW) {
    return false;
  }
  if (requireJsonObject && !(model.supported_parameters ?? []).includes("response_format")) {
    return false;
  }
  return true;
}

/**
 * OpenRouter's catalog is identical for every caller (the endpoint doesn't even
 * require a key), so it's cached process-wide rather than per user. The list
 * changes a few times a day at most and the response is ~1 MB, so a short TTL
 * plus single-flight keeps the settings page from re-downloading it per visit.
 */
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

let modelsCache: { fetchedAt: number; models: OpenRouterModel[] } | null = null;
let inflightModels: Promise<OpenRouterModel[]> | null = null;

/** Test seam: drops the cached catalog. */
export function clearOpenRouterModelsCache(): void {
  modelsCache = null;
  inflightModels = null;
}

async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter model list failed (${response.status}): ${response.statusText}`);
  }
  const parsed = modelsResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("OpenRouter returned an unexpected model list response");
  }
  return parsed.data.data;
}

/**
 * Lists OpenRouter's full model catalog, cached process-wide. A refresh failure
 * falls back to the stale cache when there is one — a momentarily unreachable
 * OpenRouter shouldn't empty the user's model picker.
 */
export async function listOpenRouterModels(): Promise<OpenRouterModel[]> {
  const now = Date.now();
  if (modelsCache && now - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.models;
  }
  inflightModels ??= fetchOpenRouterModels()
    .then((models) => {
      modelsCache = { fetchedAt: Date.now(), models };
      return models;
    })
    .catch((error: unknown) => {
      if (modelsCache) {
        logger.warn("Failed to refresh OpenRouter model list, serving stale cache", {
          error: error instanceof Error ? error.message : String(error),
        });
        return modelsCache.models;
      }
      throw error;
    })
    .finally(() => {
      inflightModels = null;
    });
  return inflightModels;
}
