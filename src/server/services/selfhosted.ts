/**
 * The operator's own speech server, used for cloud voices only: Kokoro behind
 * Kokoro-FastAPI's API (OpenAI's `/audio/speech`, plus `/audio/voices` to list
 * voices) at `SELFHOSTED_BASE_URL`, e.g. `http://kokoro.internal:8880/v1`.
 * Kokoro-FastAPI checks no key itself: put it behind something that checks
 * `SELFHOSTED_API_KEY` as a bearer token, or keep it on a private network.
 *
 * Behind Cloudflare Access, set `SELFHOSTED_CF_ACCESS_CLIENT_ID` and
 * `SELFHOSTED_CF_ACCESS_CLIENT_SECRET` to a service token and every request
 * carries it.
 *
 * Requests carry a priority ({@link SELFHOSTED_PRIORITIES}). A request the
 * server is too busy to start soon gets a 503 at once, before any audio, so
 * it fails over like any busy answer; audio it has started isn't cut short.
 */

import { z } from "zod";
import { aiProviderName } from "@/lib/ai/providers";
import { USER_AGENT } from "@/server/http/user-agent";
import { pcmOrWav, type PcmStream } from "@/server/services/speech-encoding";
import { providerError, ProviderRejectedError } from "@/server/services/provider-errors";
import { CatalogCache } from "@/server/services/catalog-cache";
import type { SpeechUrgency } from "@/server/services/speech";

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

/**
 * The server's request priorities (0–255, higher first; only their order
 * matters): the chunk a listener is waiting for before chunks fetched ahead,
 * and within each, paid plans before free. They must be at most the
 * `max_priority` of the server's key for Lion Reader, or it answers 400.
 */
const SELFHOSTED_PRIORITIES = {
  waiting: { high: 240, low: 200 },
  ahead: { high: 140, low: 100 },
} as const;

/** Voices as ids, or (newer Kokoro-FastAPI) objects with an id. */
const voicesSchema = z.object({
  voices: z.array(z.union([z.string(), z.object({ id: z.string() })])),
});

function accessHeaders(): Record<string, string> {
  const id = process.env.SELFHOSTED_CF_ACCESS_CLIENT_ID;
  const secret = process.env.SELFHOSTED_CF_ACCESS_CLIENT_SECRET;
  if (!id !== !secret) {
    throw new Error(
      "Set both SELFHOSTED_CF_ACCESS_CLIENT_ID and SELFHOSTED_CF_ACCESS_CLIENT_SECRET, or neither"
    );
  }
  return id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
}

/** Throws if the self-hosted server's settings can't work, so startup fails instead. */
export function checkSelfHostedConfig(): void {
  accessHeaders();
  if (process.env.SELFHOSTED_API_KEY) apiUrl();
}

function headers(apiKey: string): Record<string, string> {
  return { "User-Agent": USER_AGENT, Authorization: `Bearer ${apiKey}`, ...accessHeaders() };
}

/**
 * Requests don't follow redirects (`redirect: "manual"`): fetch would carry the
 * Access headers to wherever one points, and the page there (Access's sign-in
 * page, for a token it refuses) isn't voices or audio. A redirect is refused as
 * Access refuses a bad token outright, as a 403, since retrying won't help.
 */
async function failure(response: Response): Promise<Error> {
  const provider = aiProviderName("selfhosted");
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return new ProviderRejectedError(
      `${provider} request was redirected to ${response.headers.get("location")}`,
      provider,
      null,
      403
    );
  }
  return providerError(provider, response);
}

async function fetchVoices(apiKey: string): Promise<string[]> {
  const response = await fetch(`${apiUrl()}/audio/voices`, {
    headers: headers(apiKey),
    redirect: "manual",
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await failure(response);
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
  signal: AbortSignal,
  { waiting, planPriority }: SpeechUrgency
): Promise<PcmStream> {
  const response = await fetch(`${apiUrl()}/audio/speech`, {
    method: "POST",
    headers: { ...headers(apiKey), "Content-Type": "application/json" },
    redirect: "manual",
    signal,
    body: JSON.stringify({
      model,
      voice,
      input,
      response_format: "pcm",
      stream: true,
      priority: SELFHOSTED_PRIORITIES[waiting ? "waiting" : "ahead"][planPriority],
    }),
  });
  if (!response.ok || !response.body) throw await failure(response);
  return pcmOrWav(response.body, PCM_FORMAT);
}
