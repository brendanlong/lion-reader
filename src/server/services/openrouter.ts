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
 * Timeouts. Every outbound fetch in the repo caps itself rather than inheriting
 * undici's ~5-minute default, and these two especially: the catalog fetch is
 * shared process-wide by {@link listOpenRouterModels}, so a request that hangs
 * would hang every user's model picker with it.
 *
 * Completions get much longer than the catalog — a reasoning model working
 * through a long article legitimately takes a while — but still finite.
 */
const MODELS_FETCH_TIMEOUT_MS = 15_000;
const COMPLETION_TIMEOUT_MS = 180_000;

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
    signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
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
 * display on. Everything but `id` is optional, so an added or nulled field
 * can't fail the parse.
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

/**
 * Per-entry `.catch(null)` so one malformed model out of ~370 (a type change on
 * a field we model, say `context_length` arriving as a string) costs us that
 * one model rather than the entire catalog — which would silently empty the
 * user's picker of every OpenRouter option.
 */
const modelsResponseSchema = z.object({
  data: z.array(openRouterModelSchema.nullable().catch(null)),
});

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

/**
 * How long a failed refresh suppresses the next attempt. Without this, an
 * OpenRouter outage turns every settings-page load into another (~1 MB,
 * timeout-length) request while the stale cache is being served anyway.
 */
const MODELS_REFRESH_RETRY_MS = 60 * 1000;

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
    signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter model list failed (${response.status}): ${response.statusText}`);
  }
  // A non-JSON body (gateway HTML error page) would otherwise surface as a bare
  // SyntaxError with no hint of where it came from.
  const body: unknown = await response.json().catch(() => null);
  const parsed = modelsResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("OpenRouter returned an unexpected model list response");
  }
  // Drop only the entries that failed to parse — see modelsResponseSchema.
  return parsed.data.data.filter((model) => model !== null);
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
        // Push the stale entry's age back so the next caller serves it outright
        // instead of re-attempting a failing fetch on every settings-page load.
        modelsCache = {
          models: modelsCache.models,
          fetchedAt: Date.now() - MODELS_CACHE_TTL_MS + MODELS_REFRESH_RETRY_MS,
        };
        return modelsCache.models;
      }
      throw error;
    })
    .finally(() => {
      inflightModels = null;
    });
  return inflightModels;
}
