/**
 * BreezeBlue client, used for cloud voices only.
 *
 * BreezeBlue has thousands of voices, so we offer a few: the key owner's own
 * (the ones they favorited on BreezeBlue and the ones they made), then the
 * trending English narration voices; `speech.ts` keeps a picked voice that has
 * left those ({@link findBreezeBlueVoice}). Everything is cached per key and never
 * shown for another: even the models and trending voices are the account's
 * view (it can rename a voice in its library, and models are per account).
 */

import { z } from "zod";
import { USER_AGENT } from "@/server/http/user-agent";
import { pcmOrWav, type PcmStream } from "@/server/services/speech-encoding";
import { providerError } from "@/server/services/provider-errors";
import { CatalogCache } from "@/server/services/catalog-cache";

/** Overridable for tests, like the SDKs' `GROQ_BASE_URL`. */
function apiUrl(): string {
  return process.env.BREEZEBLUE_BASE_URL ?? "https://api.breeze.blue/v1";
}
const CATALOG_TIMEOUT_MS = 15_000;
/** Short, so a voice favorited on BreezeBlue shows up soon. */
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Before a refresh that failed is tried again; a first fetch's failure is kept
 * as long, so an outage doesn't cost every chunk a timeout.
 */
const CATALOG_FAILURE_TTL_MS = 30 * 1000;
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
  primary_category_code: z.string().nullish(),
});

interface ListedVoice extends BreezeBlueVoice {
  narration: boolean;
}

const voicesPageSchema = z.object({ voices: z.array(z.unknown()) });

function headers(apiKey: string): Record<string, string> {
  return { "User-Agent": USER_AGENT, "xi-api-key": apiKey };
}

async function getJson(apiKey: string, path: string): Promise<unknown> {
  const response = await fetch(`${apiUrl()}${path}`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw await providerError("BreezeBlue", response);
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

async function fetchVoices(apiKey: string, query: string): Promise<ListedVoice[]> {
  const page = voicesPageSchema.parse(await getJson(apiKey, `/voices?${query}`));
  return page.voices.flatMap((entry) => {
    const parsed = voiceSchema.safeParse(entry);
    if (!parsed.success) return [];
    return [
      {
        id: parsed.data.voice_id,
        name: breezeBlueVoiceName(parsed.data),
        narration: parsed.data.primary_category_code === "narration",
      },
    ];
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

async function fetchCatalog(apiKey: string): Promise<BreezeBlueCatalog> {
  const [models, favorites, personal, trending] = await Promise.all([
    fetchModels(apiKey),
    // Library voices only, which trending sorting requires; the ones the
    // owner made come from the next query.
    fetchVoices(apiKey, "favorites_only=true&voice_type=default&sort=trend&page_size=100"),
    fetchVoices(apiKey, "voice_type=personal&page_size=100"),
    fetchVoices(
      apiKey,
      `voice_type=default&primary_category_code=narration&language_code=en&sort=trend&page_size=${TRENDING_VOICES}`
    ),
  ]);
  // Favorites by popularity, narration voices first: the first is the default.
  const own = [
    ...favorites.filter((voice) => voice.narration),
    ...favorites.filter((voice) => !voice.narration),
    ...personal,
  ];
  const ownIds = new Set(own.map((voice) => voice.id));
  const voices = [...own, ...trending.filter((voice) => !ownIds.has(voice.id))];
  return { models, voices: voices.map(({ id, name }) => ({ id, name })) };
}

const catalogs = new CatalogCache(fetchCatalog, {
  ttlMs: CATALOG_CACHE_TTL_MS,
  retryMs: CATALOG_FAILURE_TTL_MS,
  failureTtlMs: CATALOG_FAILURE_TTL_MS,
  maxEntries: MAX_CACHED_KEYS,
});

/** The models, and the voices this key is offered: its own, then trending ones. */
export function getBreezeBlueCatalog(apiKey: string): Promise<BreezeBlueCatalog> {
  return catalogs.get(apiKey);
}

/**
 * Voice `id` as this key sees it, whether or not the catalog lists it (a voice
 * picked from trending can leave the list any day); null if the key has no
 * such voice (BreezeBlue answers 404 `RESOURCE_NOT_FOUND`). Not cached: the
 * caller decides when a lookup is worth its request.
 */
export async function findBreezeBlueVoice(
  apiKey: string,
  id: string
): Promise<BreezeBlueVoice | null> {
  // encodeURIComponent leaves these alone, and they'd be a path segment.
  if (id === "." || id === "..") return null;
  const response = await fetch(`${apiUrl()}/voices/${encodeURIComponent(id)}`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw await providerError("BreezeBlue", response);
  const parsed = voiceSchema.safeParse(await response.json());
  return parsed.success && parsed.data.voice_id === id
    ? { id, name: breezeBlueVoiceName(parsed.data) }
    : null;
}

/**
 * Square brackets are BreezeBlue's vocal-event markup in Chinese (`[笑]` is a
 * laugh), and in English text they can turn the speech to gibberish. English
 * reads them fine as parentheses ("[sic]", "[1]").
 */
function bracketsAsParentheses(text: string): string {
  return text.replaceAll("[", "(").replaceAll("]", ")");
}

/**
 * Speech as PCM, streamed as it's generated. `enable_logging=false` keeps it
 * out of the key owner's generation history; it's documented only for
 * realtime sessions, but this endpoint honours it too.
 */
export async function breezeBlueSpeech(
  apiKey: string,
  model: string,
  voice: string,
  text: string,
  signal: AbortSignal
): Promise<PcmStream> {
  const response = await fetch(
    `${apiUrl()}/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm&enable_logging=false`,
    {
      method: "POST",
      headers: { ...headers(apiKey), "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ text: bracketsAsParentheses(text), model_id: model }),
    }
  );
  if (!response.ok || !response.body) throw await providerError("BreezeBlue", response);
  return pcmOrWav(response.body, PCM_FORMAT);
}
