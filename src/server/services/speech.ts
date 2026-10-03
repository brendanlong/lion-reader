/**
 * Cloud voices: server-side text-to-speech through the providers in
 * {@link SPEECH_PROVIDER_ADAPTERS}. Keys stay on the server, so the browser
 * gets audio from our API rather than calling a provider itself.
 */

import { formatModelRef, normalizeModelRef, parseModelRef } from "@/lib/ai/model-ref";
import {
  aiProviderName,
  aiProviderNames,
  SPEECH_PROVIDERS,
  type SpeechProvider,
} from "@/lib/ai/providers";
import { DEFAULT_CLOUD_VOICE_MODELS, DEFAULT_CLOUD_VOICES } from "@/lib/narration/constants";
import { logger } from "@/lib/logger";
import {
  getProviderApiKey,
  isModelAllowed,
  isOnUserKey,
  UnreadableApiKeyError,
  type AiProviderKeys,
} from "@/server/services/ai-providers";
import { UNREADABLE_API_KEY } from "@/server/services/unreadable-api-key";
import { encodeSpeech, type PcmStream } from "@/server/services/speech-encoding";
import { setTimeout } from "node:timers/promises";
import {
  classifyProviderError,
  ProviderBusyError,
  ProviderRejectedError,
} from "@/server/services/provider-errors";
import {
  deepInfraSpeech,
  listDeepInfraSpeechModels,
  type DeepInfraSpeechModel,
} from "@/server/services/deepinfra";
import {
  breezeBlueSpeech,
  findBreezeBlueVoice,
  getBreezeBlueCatalog,
  type BreezeBlueCatalog,
} from "@/server/services/breezeblue";
import { checkRateLimit } from "@/server/rate-limit";
import {
  listOpenRouterModels,
  openRouterSpeech,
  pricePerMillionUnits,
  type OpenRouterModel,
} from "@/server/services/openrouter";

export interface SpeechVoice {
  /** What the provider calls the voice; what's stored and sent. */
  id: string;
  /** What the user sees: the id, for providers that don't name voices. */
  name: string;
}

export interface SpeechModel {
  /** `provider:model` ref. */
  id: string;
  displayName: string;
  provider: SpeechProvider;
  voices: SpeechVoice[];
  /** USD per million input characters. */
  pricePerMillionCharacters?: number;
}

/**
 * A cloud voice provider's catalog and synthesis. A provider is also an
 * `AiProvider` (`@/lib/ai/providers`), which is where its name and key live.
 */
interface SpeechProviderAdapter {
  /** The models the user can pick on these keys; `apiKey` is this provider's. */
  listModels(keys: AiProviderKeys | undefined, apiKey: string): Promise<SpeechModel[]>;
  /**
   * For a provider that lists only some of its voices: `voice` as `apiKey`
   * sees it, or null if it has none such (see {@link keepPickedVoice}).
   */
  findVoice?(apiKey: string, voice: string): Promise<SpeechVoice | null>;
  /**
   * `text` spoken by `voice` of `model` (provider-native ids), as PCM streamed
   * as it's generated. Rejects when the provider refuses.
   */
  speak(
    apiKey: string,
    model: string,
    voice: string,
    text: string,
    signal: AbortSignal
  ): Promise<PcmStream>;
}

const SPEECH_PROVIDER_ADAPTERS: Record<SpeechProvider, SpeechProviderAdapter> = {
  deepinfra: {
    listModels: async (keys) => toDeepInfraSpeechModels(await listDeepInfraSpeechModels(), keys),
    speak: deepInfraSpeech,
  },
  openrouter: {
    listModels: async (keys) => toSpeechModels(await listOpenRouterModels("speech"), keys),
    speak: openRouterSpeech,
  },
  breezeblue: {
    listModels: async (keys, apiKey) =>
      toBreezeBlueSpeechModels(await getBreezeBlueCatalog(apiKey), keys),
    findVoice: findBreezeBlueVoice,
    speak: breezeBlueSpeech,
  },
};

function voicesNamedById(ids: string[]): SpeechVoice[] {
  return ids.map((id) => ({ id, name: id }));
}

export interface SpeechCatalog {
  /** Models with at least one voice. */
  models: SpeechModel[];
  /** Providers with a key whose catalog couldn't be fetched just now, and why. */
  unavailable: { provider: SpeechProvider; error: unknown }[];
  /**
   * The picked voice is missing from its model's voices only because it
   * couldn't be checked just now (a failed or rate-limited lookup), not
   * because the provider has no such voice.
   */
  pickedVoiceUnchecked?: boolean;
}

/** The model and voice a user picked (null: the defaults). */
export interface SpeechChoice {
  model: string | null;
  voice: string | null;
  userId: string;
}

/**
 * Speech models the user can pick, across the providers that have a key. A
 * provider whose catalog can't be fetched is logged and left out, so the
 * others still show up. Given the user's pick, its voice is kept among its
 * model's voices while the provider has it ({@link keepPickedVoice}).
 */
export async function listSpeechModels(
  keys?: AiProviderKeys,
  picked?: SpeechChoice
): Promise<SpeechCatalog> {
  const unavailable: SpeechCatalog["unavailable"] = [];
  const lists = await Promise.all(
    SPEECH_PROVIDERS.flatMap((provider) => {
      const apiKey = getProviderApiKey(provider, keys);
      return apiKey ? [{ provider, apiKey }] : [];
    }).map(async ({ provider, apiKey }) => {
      try {
        return await SPEECH_PROVIDER_ADAPTERS[provider].listModels(keys, apiKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ProviderRejectedError) {
          logger.warn("Speech provider refused to list models", { provider, error: message });
        } else {
          logger.error("Failed to list speech models", { provider, error: message });
        }
        unavailable.push({ provider, error });
        return [];
      }
    })
  );
  const models = lists
    .flat()
    .filter((model) => model.voices.length > 0)
    .sort(byDisplayName);
  const kept = picked?.voice ? await keepPickedVoice(models, keys, picked) : "listed";
  return { models, unavailable, ...(kept === "unchecked" ? { pickedVoiceUnchecked: true } : {}) };
}

/** How long a picked voice's lookup is trusted, found or not. */
const KEPT_VOICE_TTL_MS = 5 * 60 * 1000;
/** How long a lookup that failed is, before asking again. */
const KEPT_VOICE_FAILURE_TTL_MS = 30 * 1000;
const MAX_KEPT_VOICES = 1000;

/**
 * Each user's latest lookup per provider key: one entry per user, so a user
 * changing voices only ever replaces their own, and nobody can push the
 * others' out faster than by being that many users.
 */
const keptVoices = new Map<
  string,
  {
    voice: string;
    expiresAt: number;
    /** The voice; null if the key has none such; "unchecked" if it couldn't be asked. */
    found: Promise<SpeechVoice | null | "unchecked">;
  }
>();

/**
 * Adds the picked voice to its model's voices when the provider no longer
 * offers it (BreezeBlue lists the key's own and the day's trending voices;
 * a voice picked from trending would otherwise silently change). Only for the
 * model the request would run on, which is only listed if it's allowed on the
 * key it would bill: so a lookup is never made for a model the user can't
 * use. Lookups are cached per user and rate-limited, since on the server's
 * key they're made with the operator's account. A voice the key doesn't have
 * is left out (the request falls back to the model's default voice); one that
 * couldn't be checked is left out too, but reported "unchecked", so speech
 * can refuse for now rather than say it in the wrong voice.
 */
async function keepPickedVoice(
  models: SpeechModel[],
  keys: AiProviderKeys | undefined,
  { model: pickedModel, voice, userId }: SpeechChoice
): Promise<"listed" | "kept" | "missing" | "unchecked"> {
  if (!voice) return "listed";
  const id = targetSpeechModelId(models, keys, pickedModel);
  // The voice was picked for a model this request won't run on.
  if (pickedModel && id !== normalizeModelRef(pickedModel)) return "listed";
  const index = models.findIndex((candidate) => candidate.id === id);
  const model = models[index];
  const findVoice = model && SPEECH_PROVIDER_ADAPTERS[model.provider].findVoice;
  if (!model || hasVoice(model, voice)) return "listed";
  const apiKey = getProviderApiKey(model.provider, keys);
  if (!findVoice || !apiKey) return "missing";

  const slot = JSON.stringify([userId, model.provider, apiKey]);
  const now = Date.now();
  let entry = keptVoices.get(slot);
  if (!entry || entry.voice !== voice || now >= entry.expiresAt) {
    // In the map before anything is awaited, so a user's parallel requests
    // (the player's look-ahead) share one lookup and one rate-limit token.
    const lookup: NonNullable<typeof entry> = {
      voice,
      expiresAt: now + KEPT_VOICE_TTL_MS,
      found: Promise.resolve(null),
    };
    lookup.found = (async () => {
      const limit = await checkRateLimit(`user:${userId}`, "voiceLookup", {
        fallback: "memory",
      });
      if (!limit.allowed) {
        // Asked again on the next request, which pays for the limit check only.
        lookup.expiresAt = 0;
        return "unchecked";
      }
      try {
        return await findVoice(apiKey, voice);
      } catch (error) {
        logger.warn("Couldn't look up a picked speech voice", {
          provider: model.provider,
          error: error instanceof Error ? error.message : String(error),
        });
        lookup.expiresAt = Date.now() + KEPT_VOICE_FAILURE_TTL_MS;
        return "unchecked";
      }
    })();
    entry = lookup;
    keptVoices.delete(slot);
    keptVoices.set(slot, entry);
    // Oldest first, since every entry is (re)inserted when looked up.
    for (const oldest of keptVoices.keys()) {
      if (keptVoices.size <= MAX_KEPT_VOICES) break;
      keptVoices.delete(oldest);
    }
  }
  const kept = await entry.found;
  if (kept === "unchecked") return kept;
  if (!kept) return "missing";
  models[index] = { ...model, voices: [...model.voices, kept] };
  return "kept";
}

/**
 * OpenRouter's speech models the user can pick: those that list voices and are
 * allowed on the key they'd run on (see `isModelAllowed`).
 */
export function toSpeechModels(
  catalog: OpenRouterModel[],
  keys: AiProviderKeys | undefined
): SpeechModel[] {
  return catalog
    .flatMap((model): SpeechModel[] => {
      const voices = model.supported_voices ?? [];
      const id = formatModelRef("openrouter", model.id);
      const price = pricePerMillionCharacters(model);
      if (voices.length === 0 || !isModelAllowed(id, keys, { pricePerMillionCharacters: price })) {
        return [];
      }
      return [
        {
          id,
          displayName: model.name,
          provider: "openrouter",
          voices: voicesNamedById(voices),
          pricePerMillionCharacters: price,
        },
      ];
    })
    .sort(byDisplayName);
}

function byDisplayName(a: SpeechModel, b: SpeechModel): number {
  return a.displayName.localeCompare(b.displayName);
}

/** DeepInfra's speech models the user can pick, like {@link toSpeechModels}. */
export function toDeepInfraSpeechModels(
  catalog: DeepInfraSpeechModel[],
  keys: AiProviderKeys | undefined
): SpeechModel[] {
  return catalog
    .flatMap((model): SpeechModel[] => {
      const id = formatModelRef("deepinfra", model.name);
      if (!isModelAllowed(id, keys, model)) return [];
      return [
        {
          id,
          // "hexgrad/Kokoro-82M" → "hexgrad: Kokoro 82M", like OpenRouter's names.
          displayName: model.name.replace("/", ": ").replaceAll("-", " "),
          provider: "deepinfra",
          voices: voicesNamedById(model.voices),
          pricePerMillionCharacters: model.pricePerMillionCharacters,
        },
      ];
    })
    .sort(byDisplayName);
}

/** BreezeBlue's models, each with the voices this key can pick from. */
function toBreezeBlueSpeechModels(
  catalog: BreezeBlueCatalog,
  keys: AiProviderKeys | undefined
): SpeechModel[] {
  return catalog.models
    .map((model): SpeechModel => ({
      id: formatModelRef("breezeblue", model.id),
      displayName: model.name,
      provider: "breezeblue",
      voices: catalog.voices,
    }))
    .filter((model) => isModelAllowed(model.id, keys))
    .sort(byDisplayName);
}

/**
 * Speech models are billed per input character (`pricing.prompt`), except
 * those that also bill generated audio (`pricing.completion`, e.g. Gemini TTS
 * per audio token), whose per-character cost we can't state.
 */
function pricePerMillionCharacters(model: OpenRouterModel): number | undefined {
  const completion = pricePerMillionUnits(model.pricing?.completion);
  if (completion === undefined || completion > 0) return undefined;
  return pricePerMillionUnits(model.pricing?.prompt);
}

/** The model used when the user hasn't picked one (or theirs is gone). */
export function defaultSpeechModelId(models: SpeechModel[]): string {
  const ids = new Set(models.map((model) => model.id));
  return (
    DEFAULT_CLOUD_VOICE_MODELS.find((id) => ids.has(id)) ??
    models[0]?.id ??
    DEFAULT_CLOUD_VOICE_MODELS[0]
  );
}

/**
 * The model a request for `requestedModel` (null: the default) runs on: the
 * one asked for if it's listed or on the user's own key (which is then an
 * error if the provider stopped listing it), else the default.
 */
export function targetSpeechModelId(
  models: SpeechModel[],
  keys: AiProviderKeys | undefined,
  requestedModel: string | null
): string {
  if (!requestedModel) return defaultSpeechModelId(models);
  const requested = normalizeModelRef(requestedModel);
  return isOnUserKey(parseModelRef(requested).provider, keys) ||
    models.some((candidate) => candidate.id === requested)
    ? requested
    : defaultSpeechModelId(models);
}

function hasVoice(model: SpeechModel, voice: string): boolean {
  return model.voices.some((candidate) => candidate.id === voice);
}

/** The id of the voice used when the user hasn't picked one. */
export function defaultVoiceFor(model: SpeechModel): string {
  const preferred = DEFAULT_CLOUD_VOICES[model.id];
  return preferred && hasVoice(model, preferred) ? preferred : model.voices[0].id;
}

export class SpeechRequestError extends Error {}

/** A provider refused this key or request; the message is for the user. */
export class SpeechRejectedError extends Error {}

/** A provider's catalog couldn't be fetched: likely to pass, so worth trying again. */
export class SpeechUnavailableError extends Error {}

/**
 * What to tell the user about a provider refusing: on their own key, what the
 * provider said (a bad key, no credit), which they can act on; on the
 * server's, nothing about the operator's account.
 */
function speechRejection(
  provider: SpeechProvider,
  error: ProviderRejectedError,
  keys: AiProviderKeys
): SpeechRejectedError {
  const name = aiProviderName(provider);
  if (!isOnUserKey(provider, keys)) {
    return new SpeechRejectedError(`${name} cloud voices aren't available right now`);
  }
  return new SpeechRejectedError(
    error.detail
      ? `${name} refused the request: ${error.detail}`
      : `${name} refused the request; check your ${name} API key`
  );
}

/**
 * The model and voice to synthesize with: the model by
 * {@link targetSpeechModelId}, refused for now if the user's own key for it
 * can't be read.
 */
export function resolveSpeechModel(
  { models, unavailable }: SpeechCatalog,
  keys: AiProviderKeys,
  requestedModel: string | null,
  requestedVoice: string | null
): { model: SpeechModel; voice: string } {
  const requestedProvider = requestedModel ? parseModelRef(requestedModel).provider : null;
  if (requestedProvider && keys[requestedProvider] === UNREADABLE_API_KEY) {
    throw new SpeechRejectedError(new UnreadableApiKeyError(requestedProvider).message);
  }
  const failed =
    unavailable.find(({ provider }) => provider === requestedProvider) ??
    (models.length === 0 ? unavailable[0] : undefined);
  if (failed) {
    if (failed.error instanceof ProviderRejectedError) {
      throw speechRejection(failed.provider, failed.error, keys);
    }
    throw new SpeechUnavailableError(
      `Couldn't get ${aiProviderName(failed.provider)}'s cloud voices; try again shortly`
    );
  }
  if (models.length === 0) {
    throw new SpeechRequestError(
      `Cloud voices require an API key from ${aiProviderNames(SPEECH_PROVIDERS)}`
    );
  }
  const modelId = targetSpeechModelId(models, keys, requestedModel);
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new SpeechRequestError(`Speech model not available: ${modelId}`);
  }
  // A stored voice the model no longer lists falls back to the default, the
  // same voice the settings page shows as selected.
  const voice =
    requestedVoice && hasVoice(model, requestedVoice) ? requestedVoice : defaultVoiceFor(model);
  return { model, voice };
}

/** Longest a provider gets to finish a chunk. */
const SPEECH_TIMEOUT_MS = 120_000;
/**
 * `text` spoken as AAC in fragmented MP4 (see `speech-encoding.ts`), streamed
 * as the provider generates it, ending in `pauseSeconds` of silence. A null model
 * or voice means the default. Rejects models the user can't pick in settings,
 * so this can't be used to run arbitrary (or arbitrarily expensive) models.
 * Aborting `signal` (the client went away) stops the provider's request. A
 * provider that's busy is asked again for a while ({@link speakWhenFree}).
 */
export async function streamSpeech(
  keys: AiProviderKeys,
  options: SpeechChoice & { text: string; pauseSeconds?: number },
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const catalog = await listSpeechModels(keys, options);
  const { model, voice } = resolveSpeechModel(catalog, keys, options.model, options.voice);
  // Saying it in the default voice instead would be cached as the picked one's.
  if (catalog.pickedVoiceUnchecked && voice !== options.voice) {
    throw new SpeechUnavailableError(
      `Couldn't check the voice with ${aiProviderName(model.provider)}; try again shortly`
    );
  }
  const apiKey = getProviderApiKey(model.provider, keys);
  if (!apiKey) {
    throw new SpeechRequestError(`Speech model not available: ${model.id}`);
  }
  const providerModel = parseModelRef(model.id).model;
  const timeout = AbortSignal.timeout(SPEECH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let pcm: PcmStream;
  try {
    pcm = await speakWhenFree(
      () =>
        SPEECH_PROVIDER_ADAPTERS[model.provider].speak(
          apiKey,
          providerModel,
          voice,
          options.text,
          combined
        ),
      combined
    );
  } catch (error) {
    if (error instanceof ProviderRejectedError) {
      logger.warn("Speech provider refused", { model: model.id, error: error.message });
      throw speechRejection(model.provider, error, keys);
    }
    // A provider that couldn't be reached is busy too: the client is told to
    // come back later, as for a 503.
    if (!(error instanceof ProviderBusyError) && classifyProviderError(error) === "busy") {
      throw new ProviderBusyError(error instanceof Error ? error.message : String(error), null);
    }
    throw error;
  }
  return encodeSpeech(pcm, { pauseSeconds: options.pauseSeconds });
}

/** How long a busy provider is asked again before the client is told to come back later. */
const BUSY_RETRY_MS = 15_000;
const BUSY_FIRST_WAIT_MS = 500;
const BUSY_MAX_WAIT_MS = 5_000;

/**
 * `speak`, asked again while the provider is busy ({@link classifyProviderError}:
 * a plan's concurrency limit, say, which several listeners on the server's key
 * can hit together, or an overloaded or unreachable provider), waiting as long
 * as it asks, within reason. Past {@link BUSY_RETRY_MS} the last busy error is
 * thrown, for the client to retry later.
 */
export async function speakWhenFree<T>(
  speak: () => Promise<T>,
  signal: AbortSignal,
  budgetMs = BUSY_RETRY_MS
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let wait = BUSY_FIRST_WAIT_MS;
  for (;;) {
    try {
      return await speak();
    } catch (error) {
      if (classifyProviderError(error) !== "busy") throw error;
      const askedSeconds = error instanceof ProviderBusyError ? error.retryAfterSeconds : null;
      const asked = askedSeconds === null ? wait : askedSeconds * 1000;
      // Jittered, so listeners turned away together don't all come back together.
      const delay =
        Math.min(Math.max(asked, BUSY_FIRST_WAIT_MS), BUSY_MAX_WAIT_MS) *
        (0.8 + 0.4 * Math.random());
      if (Date.now() + delay > deadline) throw error;
      await setTimeout(delay, undefined, { signal });
      wait = Math.min(wait * 2, BUSY_MAX_WAIT_MS);
    }
  }
}
