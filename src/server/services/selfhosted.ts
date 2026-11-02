/**
 * The operator's own speech server, used for cloud voices only: Kokoro behind
 * Kokoro-FastAPI's API (OpenAI's `/audio/speech`, plus `/audio/voices` to list
 * voices) at `SELFHOSTED_BASE_URL`, e.g. `http://kokoro.internal:8880/v1`.
 * Kokoro-FastAPI checks no key itself: put it behind something that checks
 * `SELFHOSTED_API_KEY` as a bearer token, or keep it on a private network.
 */

import { z } from "zod";
import { aiProviderName } from "@/lib/ai/providers";
import { USER_AGENT } from "@/server/http/user-agent";
import { pcmOrWav, type PcmStream } from "@/server/services/speech-encoding";
import { providerError } from "@/server/services/provider-errors";
import { CatalogCache } from "@/server/services/catalog-cache";

function apiUrl(): string {
  const url = process.env.SELFHOSTED_BASE_URL;
  if (!url) throw new Error("SELFHOSTED_API_KEY is set but SELFHOSTED_BASE_URL isn't");
  return url.replace(/\/+$/, "");
}

/** Kokoro-FastAPI's name for Kokoro (it also answers to OpenAI's `tts-1`). */
export const SELFHOSTED_KOKORO_MODEL = "kokoro";
const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;
/**
 * Before a refresh that failed is tried again; a first fetch's failure is kept
 * as long, so an outage doesn't cost every chunk a timeout.
 */
const CATALOG_FAILURE_TTL_MS = 30 * 1000;
/** What Kokoro's `pcm` is. */
const PCM_FORMAT = { sampleRate: 24_000, channels: 1 };

/** Voices as ids, or (newer Kokoro-FastAPI) objects with an id. */
const voicesSchema = z.object({
  voices: z.array(z.union([z.string(), z.object({ id: z.string() })])),
});

function headers(apiKey: string): Record<string, string> {
  return { "User-Agent": USER_AGENT, Authorization: `Bearer ${apiKey}` };
}

async function fetchVoices(apiKey: string): Promise<string[]> {
  const response = await fetch(`${apiUrl()}/audio/voices`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerError(aiProviderName("selfhosted"), response);
  return voicesSchema
    .parse(await response.json())
    .voices.map((voice) => (typeof voice === "string" ? voice : voice.id));
}

const catalog = new CatalogCache(fetchVoices, {
  ttlMs: CATALOG_CACHE_TTL_MS,
  retryMs: CATALOG_FAILURE_TTL_MS,
  failureTtlMs: CATALOG_FAILURE_TTL_MS,
  maxEntries: 1,
});

/** Kokoro's voices on the server. */
export function listSelfHostedVoices(apiKey: string): Promise<string[]> {
  return catalog.get(apiKey);
}

/**
 * Speech as 16-bit PCM, streamed as it's generated, answered once the first
 * audio is in ({@link pcmOrWav}).
 */
export async function selfHostedSpeech(
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
    body: JSON.stringify({ model, voice, input, response_format: "pcm", stream: true }),
  });
  if (!response.ok || !response.body)
    throw await providerError(aiProviderName("selfhosted"), response);
  return pcmOrWav(response.body, PCM_FORMAT);
}
