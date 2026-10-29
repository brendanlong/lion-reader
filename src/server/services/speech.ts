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
import { z } from "zod";
import {
  DEFAULT_CLOUD_VOICE_MODELS,
  DEFAULT_CLOUD_VOICES,
  MAX_CLOUD_SPEECH_CHARS,
  MAX_CLOUD_SPEECH_PAUSE_SECONDS,
} from "@/lib/narration/constants";
import { jittered } from "@/lib/jitter";
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
import { listTogetherSpeechModels, togetherSpeech } from "@/server/services/together";
import { failoverModels, isFailoverModel } from "@/server/services/model-failover";

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
  /** The provider's speech models, as `apiKey` (this provider's) sees them. */
  listModels(apiKey: string): Promise<SpeechModel[]>;
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
    listModels: async () => toDeepInfraSpeechModels(await listDeepInfraSpeechModels()),
    speak: deepInfraSpeech,
  },
  openrouter: {
    listModels: async () => toSpeechModels(await listOpenRouterModels("speech")),
    speak: openRouterSpeech,
  },
  breezeblue: {
    listModels: async (apiKey) => toBreezeBlueSpeechModels(await getBreezeBlueCatalog(apiKey)),
    findVoice: findBreezeBlueVoice,
    speak: breezeBlueSpeech,
  },
  together: {
    listModels: async (apiKey) =>
      (await listTogetherSpeechModels(apiKey)).map((model) => ({
        id: formatModelRef("together", model.id),
        displayName: model.name,
        provider: "together",
        voices: voicesNamedById(model.voices),
        pricePerMillionCharacters: model.pricePerMillionCharacters,
      })),
    speak: togetherSpeech,
  },
};

function voicesNamedById(ids: string[]): SpeechVoice[] {
  return ids.map((id) => ({ id, name: id }));
}

export interface SpeechCatalog {
  /** Models with at least one voice that the user can pick. */
  models: SpeechModel[];
  /**
   * Models with a key in a `MODEL_FAILOVER` group, whether or not they can be
   * picked ({@link failoverCandidates}).
   */
  failover: SpeechModel[];
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
 * The models with voices the user can pick: those allowed on the key they'd
 * run on (see `isModelAllowed`).
 */
export function pickableSpeechModels(
  models: SpeechModel[],
  keys: AiProviderKeys | undefined
): SpeechModel[] {
  return models.filter(
    (model) =>
      model.voices.length > 0 &&
      isModelAllowed(model.id, keys, { pricePerMillionCharacters: model.pricePerMillionCharacters })
  );
}

/**
 * Speech models the user can pick, across the providers that have a key, and
 * the failover models. A provider whose catalog can't be fetched is logged and
 * left out, so the others still show up. Given the user's pick, its voice is
 * kept among its model's voices while the provider has it
 * ({@link keepPickedVoice}).
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
        return await SPEECH_PROVIDER_ADAPTERS[provider].listModels(apiKey);
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
  const all = lists.flat();
  const models = pickableSpeechModels(all, keys).sort(byDisplayName);
  const failover = all.filter((model) => isFailoverModel(model.id));
  const kept = picked?.voice ? await keepPickedVoice(models, keys, picked) : "listed";
  return {
    models,
    failover,
    unavailable,
    ...(kept === "unchecked" ? { pickedVoiceUnchecked: true } : {}),
  };
}

/** How long a picked voice's lookup is trusted, found or not. */
const KEPT_VOICE_TTL_MS = 5 * 60 * 1000;
/**
 * How long a lookup that failed is, before asking again.
 * @testonly
 */
export const KEPT_VOICE_FAILURE_TTL_MS = 30 * 1000;
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

/** OpenRouter's speech models. */
export function toSpeechModels(catalog: OpenRouterModel[]): SpeechModel[] {
  return catalog
    .map((model): SpeechModel => ({
      id: formatModelRef("openrouter", model.id),
      displayName: model.name,
      provider: "openrouter",
      voices: voicesNamedById(model.supported_voices ?? []),
      pricePerMillionCharacters: pricePerMillionCharacters(model),
    }))
    .sort(byDisplayName);
}

function byDisplayName(a: SpeechModel, b: SpeechModel): number {
  return a.displayName.localeCompare(b.displayName);
}

/** DeepInfra's speech models. */
export function toDeepInfraSpeechModels(catalog: DeepInfraSpeechModel[]): SpeechModel[] {
  return catalog
    .map((model): SpeechModel => ({
      id: formatModelRef("deepinfra", model.name),
      // "hexgrad/Kokoro-82M" → "hexgrad: Kokoro 82M", like OpenRouter's names.
      displayName: model.name.replace("/", ": ").replaceAll("-", " "),
      provider: "deepinfra",
      voices: voicesNamedById(model.voices),
      pricePerMillionCharacters: model.pricePerMillionCharacters,
    }))
    .sort(byDisplayName);
}

/** BreezeBlue's models, each with the voices this key can pick from. */
function toBreezeBlueSpeechModels(catalog: BreezeBlueCatalog): SpeechModel[] {
  return catalog.models
    .map((model): SpeechModel => ({
      id: formatModelRef("breezeblue", model.id),
      displayName: model.name,
      provider: "breezeblue",
      voices: catalog.voices,
    }))
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

/** How a failed {@link streamSpeech} is answered over HTTP. */
export interface SpeechErrorAnswer {
  status: number;
  /** tRPC's name for the status, which the REST API's errors carry. */
  code: string;
  /** For showing the user. */
  message: string;
  /** With a 503, `Retry-After`: when to ask again. */
  headers: Record<string, string>;
}

function retryAfter(seconds: number): Record<string, string> {
  return { "Retry-After": String(Math.ceil(seconds)) };
}

/**
 * When to ask a busy provider again, if it didn't say.
 * @testonly
 */
export const BUSY_RETRY_AFTER_SECONDS = 5;

/**
 * The answer to a failed {@link streamSpeech}, logged. Clients act on the
 * status: a 503 is asked again after `Retry-After`, another 5xx retried as
 * trouble that may pass, and a 4xx ends narration with the message. Both
 * speech routes answer this way, so a client handles them alike.
 */
export function speechErrorAnswer(
  error: unknown,
  logContext: Record<string, unknown>
): SpeechErrorAnswer {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProviderBusyError) {
    logger.warn("Speech provider busy", { ...logContext, error: message });
    return {
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "The cloud voice is busy; try again shortly",
      headers: retryAfter(error.retryAfterSeconds ?? BUSY_RETRY_AFTER_SECONDS),
    };
  }
  if (error instanceof SpeechUnavailableError) {
    logger.warn("Speech models unavailable", { ...logContext, error: message });
    // About as long as the failed catalog or voice lookup is remembered.
    return {
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message,
      headers: retryAfter(KEPT_VOICE_FAILURE_TTL_MS / 1000),
    };
  }
  if (error instanceof SpeechRequestError || error instanceof SpeechRejectedError) {
    logger.warn("Speech request refused", { ...logContext, error: message });
    return error instanceof SpeechRequestError
      ? { status: 400, code: "BAD_REQUEST", message, headers: {} }
      : { status: 422, code: "UNPROCESSABLE_CONTENT", message, headers: {} };
  }
  logger.error("Speech synthesis failed", { ...logContext, error: message });
  return {
    status: 500,
    code: "INTERNAL_SERVER_ERROR",
    message: "Speech synthesis failed",
    headers: {},
  };
}

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
  { models, unavailable }: Pick<SpeechCatalog, "models" | "unavailable">,
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

/**
 * A `POST /api/v1/narration/speech` body, {@link streamSpeech}'s request:
 * here rather than in the route so the OpenAPI document describes it too.
 */
export const speechRequestSchema = z.object({
  /** `provider:model` ref; null means the default model. */
  model: z.string().max(200).nullable(),
  /** Null means the model's default voice. */
  voice: z.string().max(200).nullable(),
  text: z.string().min(1).max(MAX_CLOUD_SPEECH_CHARS),
  /** Silence after the speech, so chunks played back to back pause like sentences do. */
  pauseSeconds: z.number().min(0).max(MAX_CLOUD_SPEECH_PAUSE_SECONDS).default(0),
});

/** Longest a provider gets to finish a chunk. */
const SPEECH_TIMEOUT_MS = 120_000;

/** A model and voice to say a chunk in, and the key that pays for it. */
interface SpeechCandidate {
  model: SpeechModel;
  voice: string;
  apiKey: string;
}

/**
 * Where to say a chunk when `first` fails: the other hosts of its model
 * ({@link failoverModels}) that have the same voice, in order, on the
 * server's keys. A user's own key is only used the way they picked, but the
 * server's back them up.
 */
function failoverCandidates(
  failover: SpeechModel[],
  first: SpeechModel,
  voice: string
): SpeechCandidate[] {
  return failoverModels(first.id).flatMap((id): SpeechCandidate[] => {
    const model = failover.find((candidate) => candidate.id === id);
    const apiKey = model && getProviderApiKey(model.provider);
    if (!model || !apiKey || !hasVoice(model, voice)) return [];
    return [{ model, voice, apiKey }];
  });
}

/**
 * The first of `candidates` to start speaking `text`, each failure (a key
 * that's out of credit too) moving on to the next. If none answers, the
 * first candidate's error is thrown: a busy one is then waited out as before,
 * and a refusal is the user's to act on.
 */
async function speakWithFirstFree(
  candidates: SpeechCandidate[],
  text: string,
  signal: AbortSignal
): Promise<{ candidate: SpeechCandidate; pcm: PcmStream }> {
  let firstError: unknown = null;
  for (const [index, candidate] of candidates.entries()) {
    signal.throwIfAborted();
    const { model, voice, apiKey } = candidate;
    try {
      const pcm = await SPEECH_PROVIDER_ADAPTERS[model.provider].speak(
        apiKey,
        parseModelRef(model.id).model,
        voice,
        text,
        signal
      );
      return { candidate, pcm };
    } catch (error) {
      signal.throwIfAborted();
      const failure = classifyProviderError(error);
      if (index === 0) {
        firstError = error;
      } else if (failure !== "busy") {
        logger.warn("Speech failover model failed", {
          model: model.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  throw firstError;
}

/**
 * `text` spoken as AAC in fragmented MP4 (see `speech-encoding.ts`), streamed
 * as the provider generates it, ending in `pauseSeconds` of silence. A null model
 * or voice means the default. Rejects models the user can't pick in settings,
 * so this can't be used to run arbitrary (or arbitrarily expensive) models.
 * Aborting `signal` (the client went away) stops the provider's request. A
 * provider that's busy or failing is passed over for another host of the same
 * model and voice at once ({@link failoverCandidates}, {@link speakWithFirstFree}),
 * and when all are busy, they're asked again for a while ({@link speakWhenFree}).
 * An `exact` request never fails over.
 */
export async function streamSpeech(
  keys: AiProviderKeys,
  options: SpeechChoice & {
    text: string;
    pauseSeconds?: number;
    /** Refuse rather than fall back to the default model or voice. */
    exact?: boolean;
  },
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
  if (
    options.exact &&
    (model.id !== normalizeModelRef(options.model ?? "") || voice !== options.voice)
  ) {
    throw new SpeechRequestError(`${options.model} voice ${options.voice} isn't available`);
  }
  const apiKey = getProviderApiKey(model.provider, keys);
  if (!apiKey) {
    throw new SpeechRequestError(`Speech model not available: ${model.id}`);
  }
  const candidates = [
    { model, voice, apiKey },
    ...(options.exact ? [] : failoverCandidates(catalog.failover, model, voice)),
  ];
  const timeout = AbortSignal.timeout(SPEECH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let spoken: Awaited<ReturnType<typeof speakWithFirstFree>>;
  try {
    spoken = await speakWhenFree(
      () => speakWithFirstFree(candidates, options.text, combined),
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
  const answered = spoken.candidate.model;
  if (answered !== model) {
    logger.info("Speech failed over", { model: model.id, failoverModel: answered.id });
  }
  return encodeSpeech(spoken.pcm, { pauseSeconds: options.pauseSeconds });
}

/** How long a busy provider is asked again before the client is told to come back later. */
const BUSY_RETRY_MS = 15_000;
export const BUSY_FIRST_WAIT_MS = 500;
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
      const delay = jittered(Math.min(Math.max(asked, BUSY_FIRST_WAIT_MS), BUSY_MAX_WAIT_MS));
      if (Date.now() + delay > deadline) throw error;
      await setTimeout(delay, undefined, { signal });
      wait = Math.min(wait * 2, BUSY_MAX_WAIT_MS);
    }
  }
}
