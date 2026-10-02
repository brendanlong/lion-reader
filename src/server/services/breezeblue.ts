/**
 * BreezeBlue client, used for cloud voices only.
 *
 * BreezeBlue has thousands of voices, so we offer a few: the key owner's own
 * (the ones they favorited on BreezeBlue and the ones they made), then the
 * trending English narration voices. Everything is cached per key and never
 * shown for another: even the models and trending voices are the account's
 * view (it can rename a voice in its library, and models are per account).
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
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
/** A failure is kept briefly too, so an outage doesn't cost every chunk a timeout. */
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

/** By a hash of the key, so keys aren't kept in memory longer than a request. */
const catalogs = new Map<string, { expiresAt: number; catalog: Promise<BreezeBlueCatalog> }>();

/** The models, and the voices this key can pick from. */
export function getBreezeBlueCatalog(apiKey: string): Promise<BreezeBlueCatalog> {
  const id = createHash("sha256").update(apiKey).digest("hex");
  const now = Date.now();
  const current = catalogs.get(id);
  if (current && now < current.expiresAt) return current.catalog;
  catalogs.delete(id);
  // Oldest first, since every entry is (re)inserted when fetched.
  for (const [key, entry] of catalogs) {
    if (catalogs.size < MAX_CACHED_KEYS && now < entry.expiresAt) break;
    catalogs.delete(key);
  }
  const entry = { expiresAt: now + CATALOG_CACHE_TTL_MS, catalog: fetchCatalog(apiKey) };
  catalogs.set(id, entry);
  entry.catalog.catch(() => {
    entry.expiresAt = Date.now() + CATALOG_FAILURE_TTL_MS;
  });
  return entry.catalog;
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
      body: JSON.stringify({ text, model_id: model }),
    }
  );
  if (!response.ok || !response.body) throw await errorFromResponse(response);
  return pcmOrWav(response.body, PCM_FORMAT);
}
