/**
 * DeepInfra client, used for cloud voices only.
 *
 * Speech goes through the OpenAI-compatible `/v1/audio/speech` endpoint, which
 * also takes DeepInfra's `service_tier`. We ask for `priority`: at the default
 * tier a request can queue for seconds when DeepInfra is busy, and priority
 * costs 1.5x Kokoro's already-low rate. The model catalog and each model's
 * voices are public, so they're fetched without a key and cached in-process.
 */

import { z } from "zod";
import { logger } from "@/lib/logger";
import { MAX_CLOUD_SPEECH_CHARS } from "@/lib/narration/constants";
import { USER_AGENT } from "@/server/http/user-agent";
import { pcmFromWav, pcmOrWav, type PcmStream } from "@/server/services/speech-encoding";

const DEEPINFRA_API_URL = "https://api.deepinfra.com";
const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;
const CATALOG_CACHE_RETRY_MS = 60 * 1000;
/** What `service_tier: "priority"` costs over the catalog's listed price. */
const PRIORITY_PRICE_MULTIPLIER = 1.5;

export interface DeepInfraSpeechModel {
  /** DeepInfra's model name, e.g. `hexgrad/Kokoro-82M`. */
  name: string;
  voices: string[];
  /** USD per million input characters. */
  pricePerMillionCharacters?: number;
}

const catalogEntrySchema = z.object({
  model_name: z.string(),
  type: z.string().nullish(),
  deprecated: z.unknown().nullish(),
  pricing: z.object({ cents_per_input_chars: z.number().nullish() }).nullish(),
});

/** A property, or its array items: an inline enum or a reference to one. */
const enumTypeSchema = z.object({
  $ref: z.string().optional(),
  enum: z.array(z.string()).optional(),
  const: z.string().optional(),
  anyOf: z.array(z.object({ $ref: z.string().optional() })).optional(),
});

const schemaPropertySchema = enumTypeSchema.extend({
  items: enumTypeSchema.optional(),
  maxLength: z.number().optional(),
});

type EnumType = z.infer<typeof enumTypeSchema>;

const modelDetailSchema = z.object({
  in_schema: z
    .object({
      properties: z.record(z.string(), z.unknown()).optional(),
      definitions: z
        .record(z.string(), z.object({ enum: z.array(z.string()).optional() }))
        .optional(),
    })
    .nullish(),
});

function headers(apiKey?: string): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function errorFromResponse(response: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as { detail?: unknown; error?: { message?: unknown } };
    const message = typeof body.detail === "string" ? body.detail : body.error?.message;
    if (typeof message === "string") detail = `: ${message.slice(0, 500)}`;
  } catch {
    // Non-JSON error body; the status is enough.
  }
  return new Error(`DeepInfra request failed with status ${response.status}${detail}`);
}

type InputSchema = z.infer<typeof modelDetailSchema>["in_schema"];

function propertyOf(schema: InputSchema, key: string) {
  const parsed = schemaPropertySchema.safeParse(schema?.properties?.[key]);
  return parsed.success ? parsed.data : undefined;
}

/** A property's allowed values, inline, via `items`, `$ref` or `anyOf`. */
function enumOf(schema: InputSchema, key: string): string[] | undefined {
  const property = propertyOf(schema, key);
  if (!property) return undefined;
  const type: EnumType = property.items ?? property;
  if (type.enum) return type.enum;
  if (type.const) return [type.const];
  const definitions = schema?.definitions ?? {};
  const refs = [type.$ref, ...(type.anyOf ?? []).map((entry) => entry.$ref)];
  for (const ref of refs) {
    const values = ref ? definitions[ref.split("/").pop() ?? ""]?.enum : undefined;
    if (values) return values;
  }
  return undefined;
}

/**
 * A model's preset voices: the `voice` (or Kokoro's `preset_voice`) enum.
 * Models without one clone or design voices instead, so there's nothing to pick.
 */
export function voicesFromSchema(schema: InputSchema): string[] {
  return enumOf(schema, "voice") ?? enumOf(schema, "preset_voice") ?? [];
}

/**
 * Whether a model can read a narration chunk: it takes MAX_CLOUD_SPEECH_CHARS
 * of text and can return PCM, and WAV to learn the PCM's format (see
 * {@link deepInfraSpeech}). Some can't (Orpheus caps input at 300 characters).
 */
export function canNarrate(schema: InputSchema): boolean {
  const input = propertyOf(schema, "input") ?? propertyOf(schema, "text");
  if (!input || (input.maxLength ?? Infinity) < MAX_CLOUD_SPEECH_CHARS) return false;
  const formats = enumOf(schema, "response_format") ?? enumOf(schema, "output_format");
  return (formats?.includes("pcm") && formats.includes("wav")) ?? false;
}

let cached: { expiresAt: number; models: DeepInfraSpeechModel[] } | null = null;
let refresh: Promise<DeepInfraSpeechModel[]> | null = null;

/**
 * DeepInfra's speech models that can narrate with preset voices. If a refresh fails, the
 * stale list is served and the refresh retried a minute later.
 */
export async function listDeepInfraSpeechModels(): Promise<DeepInfraSpeechModel[]> {
  const current = cached;
  if (current && Date.now() < current.expiresAt) return current.models;
  refresh ??= (async () => {
    try {
      const models = await fetchSpeechModels();
      cached = { expiresAt: Date.now() + CATALOG_CACHE_TTL_MS, models };
      return models;
    } catch (error) {
      if (!current) throw error;
      current.expiresAt = Date.now() + CATALOG_CACHE_RETRY_MS;
      return current.models;
    } finally {
      refresh = null;
    }
  })();
  return refresh;
}

async function fetchSpeechModels(): Promise<DeepInfraSpeechModel[]> {
  const response = await fetch(`${DEEPINFRA_API_URL}/models/list`, {
    headers: headers(),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await errorFromResponse(response);
  const entries = z
    .array(z.unknown())
    .parse(await response.json())
    .flatMap((entry) => {
      const parsed = catalogEntrySchema.safeParse(entry);
      return parsed.success && parsed.data.type === "text-to-speech" && !parsed.data.deprecated
        ? [parsed.data]
        : [];
    });
  // The catalog doesn't carry voices; each model's detail does. One model's
  // detail failing only drops that model.
  const models = await Promise.all(
    entries.map(async (entry): Promise<DeepInfraSpeechModel | null> => {
      try {
        const detail = await fetch(`${DEEPINFRA_API_URL}/models/${entry.model_name}`, {
          headers: headers(),
          signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
        });
        if (!detail.ok) return null;
        const parsed = modelDetailSchema.safeParse(await detail.json());
        if (!parsed.success || !canNarrate(parsed.data.in_schema)) return null;
        const voices = voicesFromSchema(parsed.data.in_schema);
        if (voices.length === 0) return null;
        const cents = entry.pricing?.cents_per_input_chars;
        return {
          name: entry.model_name,
          voices,
          // Cents per character to dollars per million characters, at the
          // priority tier we request.
          pricePerMillionCharacters:
            cents == null
              ? undefined
              : Number((cents * 10_000 * PRIORITY_PRICE_MULTIPLIER).toPrecision(6)),
        };
      } catch (error) {
        logger.warn("Skipping DeepInfra speech model", {
          model: entry.model_name,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })
  );
  return models.filter((model): model is DeepInfraSpeechModel => model !== null);
}

interface PcmFormat {
  sampleRate: number;
  channels: number;
}

/** Each model's PCM format, once a probe has asked (see {@link deepInfraSpeech}). */
const pcmFormats = new Map<string, Promise<PcmFormat>>();

/** A word for the probe to say: its WAV's header is all it's for. */
const PROBE_TEXT = "Hi.";
const PROBE_TIMEOUT_MS = 30_000;

function requestSpeech(
  apiKey: string,
  model: string,
  voice: string,
  input: string,
  format: "pcm" | "wav",
  signal: AbortSignal
): Promise<Response> {
  return fetch(`${DEEPINFRA_API_URL}/v1/audio/speech`, {
    method: "POST",
    headers: { ...headers(apiKey), "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      voice,
      input,
      response_format: format,
      stream: true,
      service_tier: "priority",
    }),
  });
}

/**
 * `model`'s PCM format, from the header of a WAV of {@link PROBE_TEXT}; asked
 * once per model (the format is the model's, whatever the key or voice) and
 * kept, unless the probe fails. The probe isn't tied to the request that
 * started it, since others may be waiting on it too.
 */
function pcmFormatOf(apiKey: string, model: string, voice: string): Promise<PcmFormat> {
  let format = pcmFormats.get(model);
  if (!format) {
    format = (async () => {
      const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      const response = await requestSpeech(apiKey, model, voice, PROBE_TEXT, "wav", signal);
      if (!response.ok || !response.body) throw await errorFromResponse(response);
      const { sampleRate, channels, data } = await pcmFromWav(response.body);
      await data.cancel();
      return { sampleRate, channels };
    })();
    pcmFormats.set(model, format);
    const probe = format;
    probe.catch(() => {
      if (pcmFormats.get(model) === probe) pcmFormats.delete(model);
    });
  }
  return format;
}

/**
 * Speech as PCM, streamed as it's generated. Only PCM streams (a WAV's header
 * gives its length, so DeepInfra sends it whole), but it has no header and
 * DeepInfra ignores a requested rate, so the format comes from a probe: a WAV
 * of a word, asked alongside the first request for each model, which answers
 * before the speech does.
 */
export async function deepInfraSpeech(
  apiKey: string,
  model: string,
  voice: string,
  input: string,
  signal: AbortSignal
): Promise<PcmStream> {
  const [speech, probed] = await Promise.allSettled([
    requestSpeech(apiKey, model, voice, input, "pcm", signal),
    pcmFormatOf(apiKey, model, voice),
  ]);
  if (speech.status === "rejected") throw speech.reason;
  const response = speech.value;
  let format: PcmFormat;
  try {
    // The probe may have been someone else's, failing for their key: once
    // more on ours (the failed one is gone from the cache by now).
    format = probed.status === "fulfilled" ? probed.value : await pcmFormatOf(apiKey, model, voice);
  } catch (error) {
    await response.body?.cancel();
    throw error;
  }
  if (!response.ok || !response.body) throw await errorFromResponse(response);
  return pcmOrWav(response.body, format);
}
