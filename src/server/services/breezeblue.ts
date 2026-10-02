/**
 * BreezeBlue client, used for cloud voices only.
 *
 * BreezeBlue has thousands of voices, so we offer a few: the key owner's own
 * (the ones they favorited on BreezeBlue and the ones they made), then the
 * trending English narration voices. A key's own voices are cached per key and
 * never shown to anyone else; the models and trending voices are the same for
 * every key, so they're cached once.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { USER_AGENT } from "@/server/http/user-agent";
import { pcmOrWav, type PcmStream } from "@/server/services/speech-encoding";

/** Overridable for tests, like the SDKs' `GROQ_BASE_URL`. */
function apiUrl(): string {
  return process.env.BREEZEBLUE_BASE_URL ?? "https://api.breeze.blue/v1";
}
const CATALOG_TIMEOUT_MS = 15_000;
/** Short, so a voice favorited on BreezeBlue shows up soon. */
const OWN_VOICES_CACHE_TTL_MS = 5 * 60 * 1000;
const SHARED_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED_KEYS = 1000;
const TRENDING_VOICES = 30;
/** What `output_format=pcm` streams; it's the only rate BreezeBlue offers. */
const PCM_FORMAT = { sampleRate: 24_000, channels: 1 };

export interface BreezeBlueModel {
  /** BreezeBlue's model id, e.g. `breeze-tts-2`. */
  id: string;
  name: string;
}

export interface BreezeBlueVoice {
  id: string;
  name: string;
}

export interface BreezeBlueCatalog {
  models: BreezeBlueModel[];
  /** The key owner's own voices first, then trending ones. */
  voices: BreezeBlueVoice[];
}

const modelSchema = z.object({ model_id: z.string(), name: z.string() });

const voiceSchema = z.object({
  voice_id: z.string(),
  name: z.string(),
  accent: z.string().nullish(),
  gender: z.string().nullish(),
  age: z.string().nullish(),
});

const voicesPageSchema = z.object({ voices: z.array(z.unknown()) });

function headers(apiKey: string): Record<string, string> {
  return { "User-Agent": USER_AGENT, "xi-api-key": apiKey };
}

async function errorFromResponse(response: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") detail = `: ${body.detail.slice(0, 500)}`;
  } catch {
    // Non-JSON error body; the status is enough.
  }
  return new Error(`BreezeBlue request failed with status ${response.status}${detail}`);
}

async function getJson(apiKey: string, path: string): Promise<unknown> {
  const response = await fetch(`${apiUrl()}${path}`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
}

/**
 * What the picker shows: names repeat across BreezeBlue's catalog, so the
 * voice's description comes along, e.g. "Elara (American, female, young)".
 */
function breezeBlueVoiceName(voice: z.infer<typeof voiceSchema>): string {
  const accent = voice.accent?.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const traits = [accent, voice.gender, voice.age?.replaceAll("_", " ")].filter(Boolean);
  return traits.length > 0 ? `${voice.name} (${traits.join(", ")})` : voice.name;
}

async function fetchVoices(apiKey: string, query: string): Promise<BreezeBlueVoice[]> {
  const page = voicesPageSchema.parse(await getJson(apiKey, `/voices?${query}`));
  return page.voices.flatMap((entry) => {
    const parsed = voiceSchema.safeParse(entry);
    return parsed.success
      ? [{ id: parsed.data.voice_id, name: breezeBlueVoiceName(parsed.data) }]
      : [];
  });
}

async function fetchModels(apiKey: string): Promise<BreezeBlueModel[]> {
  return z
    .array(z.unknown())
    .parse(await getJson(apiKey, "/models"))
    .flatMap((entry) => {
      const parsed = modelSchema.safeParse(entry);
      return parsed.success ? [{ id: parsed.data.model_id, name: parsed.data.name }] : [];
    });
}

async function fetchOwnVoices(apiKey: string): Promise<BreezeBlueVoice[]> {
  const [favorites, personal] = await Promise.all([
    fetchVoices(apiKey, "favorites_only=true&page_size=100"),
    fetchVoices(apiKey, "voice_type=personal&page_size=100"),
  ]);
  return [...favorites, ...personal];
}

function fetchTrendingVoices(apiKey: string): Promise<BreezeBlueVoice[]> {
  return fetchVoices(
    apiKey,
    `voice_type=default&primary_category_code=narration&language_code=en&sort=trend&page_size=${TRENDING_VOICES}`
  );
}

interface CacheEntry<T> {
  expiresAt: number;
  value: Promise<T>;
}

/**
 * `load`, kept for `ttlMs` once it succeeds. Fetched with whichever key asks
 * first; anyone else whose wait ends in that fetch failing (say, on a revoked
 * key) tries again on their own.
 */
function sharedCache<T>(ttlMs: number, load: (apiKey: string) => Promise<T>) {
  let entry: CacheEntry<T> | null = null;
  const start = (apiKey: string): Promise<T> => {
    const started: CacheEntry<T> = { expiresAt: Date.now() + ttlMs, value: load(apiKey) };
    entry = started;
    started.value.catch(() => {
      if (entry === started) entry = null;
    });
    return started.value;
  };
  return async (apiKey: string): Promise<T> => {
    const current = entry && Date.now() < entry.expiresAt ? entry.value : null;
    if (!current) return start(apiKey);
    try {
      return await current;
    } catch {
      return start(apiKey);
    }
  };
}

const cachedModels = sharedCache(SHARED_CACHE_TTL_MS, fetchModels);
const cachedTrendingVoices = sharedCache(SHARED_CACHE_TTL_MS, fetchTrendingVoices);

/** By a hash of the key, so keys aren't kept in memory longer than a request. */
const ownVoices = new Map<string, CacheEntry<BreezeBlueVoice[]>>();

function cachedOwnVoices(apiKey: string): Promise<BreezeBlueVoice[]> {
  const id = createHash("sha256").update(apiKey).digest("hex");
  const now = Date.now();
  const current = ownVoices.get(id);
  if (current && now < current.expiresAt) return current.value;
  for (const [key, entry] of ownVoices) {
    if (ownVoices.size < MAX_CACHED_KEYS && now < entry.expiresAt) break;
    ownVoices.delete(key);
  }
  const started = { expiresAt: now + OWN_VOICES_CACHE_TTL_MS, value: fetchOwnVoices(apiKey) };
  ownVoices.set(id, started);
  started.value.catch(() => {
    if (ownVoices.get(id) === started) ownVoices.delete(id);
  });
  return started.value;
}

/** The models, and the voices this key can pick from. */
export async function getBreezeBlueCatalog(apiKey: string): Promise<BreezeBlueCatalog> {
  const [models, own, trending] = await Promise.all([
    cachedModels(apiKey),
    cachedOwnVoices(apiKey),
    cachedTrendingVoices(apiKey),
  ]);
  const ownIds = new Set(own.map((voice) => voice.id));
  return { models, voices: [...own, ...trending.filter((voice) => !ownIds.has(voice.id))] };
}

/** Speech as PCM, streamed as it's generated. */
export async function breezeBlueSpeech(
  apiKey: string,
  model: string,
  voice: string,
  text: string,
  signal: AbortSignal
): Promise<PcmStream> {
  const response = await fetch(
    `${apiUrl()}/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm`,
    {
      method: "POST",
      headers: { ...headers(apiKey), "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ text, model_id: model }),
    }
  );
  if (!response.ok || !response.body) throw await errorFromResponse(response);
  return pcmOrWav(response.body, PCM_FORMAT);
}
