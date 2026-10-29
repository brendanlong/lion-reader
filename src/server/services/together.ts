/**
 * Together AI client, used for cloud voices only.
 *
 * Its catalog needs a key, so it's cached per key. Several of the speech
 * models it lists can only run on a dedicated endpoint (Together answers 400
 * "non-serverless model"), and nothing in the catalog says which. Those with
 * no listed price never ran serverless when tried, so they're left out; a few
 * priced ones don't either, and are refused when picked.
 */

import { z } from "zod";
import { USER_AGENT } from "@/server/http/user-agent";
import { pcmOrWav, type PcmStream } from "@/server/services/speech-encoding";
import { providerError } from "@/server/services/provider-errors";
import { CatalogCache } from "@/server/services/catalog-cache";

/** Overridable for tests, like the SDKs' `CEREBRAS_BASE_URL`. */
function apiUrl(): string {
  return process.env.TOGETHER_BASE_URL ?? "https://api.together.ai/v1";
}
const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;
const CATALOG_FAILURE_TTL_MS = 30 * 1000;
const MAX_CACHED_KEYS = 1000;
/**
 * What speech is asked for in. Kokoro and Orpheus only make this; the others
 * default to 44.1 kHz float, so it's asked for explicitly.
 */
const PCM_FORMAT = { sampleRate: 24_000, channels: 1 };

export interface TogetherSpeechModel {
  /** Together's model id, e.g. `hexgrad/Kokoro-82M`. */
  id: string;
  name: string;
  voices: string[];
  /** USD per million input characters. */
  pricePerMillionCharacters?: number;
}

const modelsSchema = z.array(
  z.object({
    id: z.string(),
    type: z.string().nullish(),
    display_name: z.string().nullish(),
    pricing: z.object({ input: z.number().nullish() }).nullish(),
  })
);

const voicesSchema = z.object({
  data: z.array(z.object({ model: z.string(), voices: z.array(z.object({ name: z.string() })) })),
});

const chunkSchema = z.object({
  type: z.string().optional(),
  delta: z.string().optional(),
  error: z.unknown().optional(),
});

function headers(apiKey: string): Record<string, string> {
  return { "User-Agent": USER_AGENT, Authorization: `Bearer ${apiKey}` };
}

async function getJson(apiKey: string, path: string): Promise<unknown> {
  const response = await fetch(`${apiUrl()}${path}`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerError("Together", response);
  return response.json();
}

async function fetchSpeechModels(apiKey: string): Promise<TogetherSpeechModel[]> {
  const [models, voices] = await Promise.all([
    getJson(apiKey, "/models").then((body) => modelsSchema.parse(body)),
    getJson(apiKey, "/voices").then((body) => voicesSchema.parse(body)),
  ]);
  const voicesByModel = new Map(
    voices.data.map((entry) => [entry.model, entry.voices.map((voice) => voice.name)])
  );
  return models.flatMap((model): TogetherSpeechModel[] => {
    const price = model.pricing?.input;
    const modelVoices = voicesByModel.get(model.id);
    if (model.type !== "audio" || !price || !modelVoices?.length) return [];
    return [
      {
        id: model.id,
        name: model.display_name ?? model.id,
        voices: modelVoices,
        pricePerMillionCharacters: price,
      },
    ];
  });
}

const catalogs = new CatalogCache(fetchSpeechModels, {
  ttlMs: CATALOG_CACHE_TTL_MS,
  retryMs: CATALOG_FAILURE_TTL_MS,
  failureTtlMs: CATALOG_FAILURE_TTL_MS,
  maxEntries: MAX_CACHED_KEYS,
});

/** The speech models this key can run serverless, with their voices. */
export function listTogetherSpeechModels(apiKey: string): Promise<TogetherSpeechModel[]> {
  return catalogs.get(apiKey);
}

/**
 * The PCM in Together's speech stream: server-sent events whose `data` is
 * JSON with base64 audio in `delta`, ending in `[DONE]`.
 */
function pcmFromEvents(events: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let buffered = "";
  const decode = (line: string): Uint8Array | null => {
    if (!line.startsWith("data:")) return null;
    const data = line.slice("data:".length).trim();
    if (data === "[DONE]") return null;
    const chunk = chunkSchema.parse(JSON.parse(data));
    if (chunk.error !== undefined || chunk.type?.includes("error")) {
      throw new Error(`Together speech failed: ${data}`);
    }
    return chunk.delta ? Buffer.from(chunk.delta, "base64") : null;
  };
  const decoder = new TextDecoder();
  return events.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        buffered += decoder.decode(bytes, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const audio = decode(line);
          if (audio?.length) controller.enqueue(audio);
        }
      },
      flush(controller) {
        const audio = decode(buffered + decoder.decode());
        if (audio?.length) controller.enqueue(audio);
      },
    })
  );
}

/**
 * Speech as 16-bit PCM, streamed as it's generated, answered once the first
 * audio is in ({@link pcmOrWav}).
 */
export async function togetherSpeech(
  apiKey: string,
  model: string,
  voice: string,
  input: string,
  signal: AbortSignal
): Promise<PcmStream> {
  const response = await fetch(`${apiUrl()}/audio/speech`, {
    method: "POST",
    headers: { ...headers(apiKey), "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      voice,
      input,
      stream: true,
      response_format: "raw",
      response_encoding: "pcm_s16le",
      sample_rate: PCM_FORMAT.sampleRate,
    }),
  });
  if (!response.ok || !response.body) throw await providerError("Together", response);
  return pcmOrWav(pcmFromEvents(response.body), PCM_FORMAT);
}
