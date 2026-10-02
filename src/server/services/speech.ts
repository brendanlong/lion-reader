/**
 * Cloud voices: server-side text-to-speech through the providers in
 * {@link SPEECH_PROVIDER_ADAPTERS}. Keys stay on the server, so the browser
 * gets audio from our API rather than calling a provider itself.
 */

import { formatModelRef, normalizeModelRef, parseModelRef } from "@/lib/ai/model-ref";
import { aiProviderNames, SPEECH_PROVIDERS, type SpeechProvider } from "@/lib/ai/providers";
import {
  DEFAULT_CLOUD_VOICE_MODELS,
  DEFAULT_CLOUD_VOICES,
  SERVER_KEY_CLOUD_VOICE_MODELS,
} from "@/lib/narration/constants";
import { logger } from "@/lib/logger";
import {
  getProviderApiKey,
  isModelAllowed,
  type AiProviderKeys,
} from "@/server/services/ai-providers";
import {
  encodeSpeech,
  withTrailingSilence,
  type PcmStream,
} from "@/server/services/speech-encoding";
import {
  deepInfraSpeech,
  listDeepInfraSpeechModels,
  type DeepInfraSpeechModel,
} from "@/server/services/deepinfra";
import {
  breezeBlueSpeech,
  getBreezeBlueCatalog,
  type BreezeBlueCatalog,
} from "@/server/services/breezeblue";
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
 * `AiProvider` (`@/lib/ai/model-ref`), which is where its name and key live.
 */
interface SpeechProviderAdapter {
  /** The models the user can pick on these keys; `apiKey` is this provider's. */
  listModels(keys: AiProviderKeys | undefined, apiKey: string): Promise<SpeechModel[]>;
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
    listModels: async (_keys, apiKey) =>
      toBreezeBlueSpeechModels(await getBreezeBlueCatalog(apiKey)),
    speak: breezeBlueSpeech,
  },
};

function voicesNamedById(ids: string[]): SpeechVoice[] {
  return ids.map((id) => ({ id, name: id }));
}

export interface SpeechCatalog {
  /** Models with at least one voice. */
  models: SpeechModel[];
  /** Providers with a key whose catalog couldn't be fetched just now. */
  unavailable: SpeechProvider[];
}

/**
 * Speech models the user can pick, across the providers that have a key. A
 * provider whose catalog can't be fetched is logged and left out, so the
 * others still show up.
 */
export async function listSpeechModels(keys?: AiProviderKeys): Promise<SpeechCatalog> {
  const unavailable: SpeechProvider[] = [];
  const lists = await Promise.all(
    SPEECH_PROVIDERS.flatMap((provider) => {
      const apiKey = getProviderApiKey(provider, keys);
      return apiKey ? [{ provider, apiKey }] : [];
    }).map(async ({ provider, apiKey }) => {
      try {
        return await SPEECH_PROVIDER_ADAPTERS[provider].listModels(keys, apiKey);
      } catch (error) {
        logger.error("Failed to list speech models", {
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
        unavailable.push(provider);
        return [];
      }
    })
  );
  const models = lists
    .flat()
    .filter((model) => model.voices.length > 0)
    .sort(byDisplayName);
  return { models, unavailable };
}

/**
 * OpenRouter's speech models the user can pick: those that list voices, limited
 * to the server-key allowlist when running on the server's key.
 */
export function toSpeechModels(
  catalog: OpenRouterModel[],
  keys: AiProviderKeys | undefined
): SpeechModel[] {
  return catalog
    .flatMap((model): SpeechModel[] => {
      const voices = model.supported_voices ?? [];
      const id = formatModelRef("openrouter", model.id);
      if (voices.length === 0 || !isModelAllowed(id, keys, SERVER_KEY_CLOUD_VOICE_MODELS)) {
        return [];
      }
      return [
        {
          id,
          displayName: model.name,
          provider: "openrouter",
          voices: voicesNamedById(voices),
          pricePerMillionCharacters: pricePerMillionCharacters(model),
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
      if (!isModelAllowed(id, keys, SERVER_KEY_CLOUD_VOICE_MODELS)) return [];
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

function hasVoice(model: SpeechModel, voice: string): boolean {
  return model.voices.some((candidate) => candidate.id === voice);
}

/** The id of the voice used when the user hasn't picked one. */
export function defaultVoiceFor(model: SpeechModel): string {
  const preferred = DEFAULT_CLOUD_VOICES[model.id];
  return preferred && hasVoice(model, preferred) ? preferred : model.voices[0].id;
}

export class SpeechRequestError extends Error {}

/**
 * The model and voice to synthesize with. A null model means the default. A
 * choice on a provider with no key left (or no longer allowed on the server's
 * key) falls back to the default; one on the user's own key is kept, and is
 * an error if the provider stopped listing it.
 */
export function resolveSpeechModel(
  { models, unavailable }: SpeechCatalog,
  keys: AiProviderKeys,
  requestedModel: string | null,
  requestedVoice: string | null
): { model: SpeechModel; voice: string } {
  const requested = requestedModel ? normalizeModelRef(requestedModel) : null;
  // Not the user's fault, and likely to pass: worth trying again, not giving up on.
  const requestedProvider = requested ? parseModelRef(requested).provider : null;
  if (
    (models.length === 0 && unavailable.length > 0) ||
    unavailable.some((provider) => provider === requestedProvider)
  ) {
    throw new Error(`Couldn't list ${unavailable.join(", ")} speech models`);
  }
  if (models.length === 0) {
    throw new SpeechRequestError(
      `Cloud voices require an API key from ${aiProviderNames(SPEECH_PROVIDERS)}`
    );
  }
  const modelId =
    requested && isModelAllowed(requested, keys, SERVER_KEY_CLOUD_VOICE_MODELS)
      ? requested
      : defaultSpeechModelId(models);
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
 * as the provider generates it, then `pauseSeconds` of silence. A null model
 * or voice means the default. Rejects models the user can't pick in settings,
 * so this can't be used to run arbitrary (or arbitrarily expensive) models.
 * Aborting `signal` (the client went away) stops the provider's request.
 */
export async function streamSpeech(
  keys: AiProviderKeys,
  options: { model: string | null; voice: string | null; text: string; pauseSeconds?: number },
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const { model, voice } = resolveSpeechModel(
    await listSpeechModels(keys),
    keys,
    options.model,
    options.voice
  );
  const apiKey = getProviderApiKey(model.provider, keys);
  if (!apiKey) {
    throw new SpeechRequestError(`Speech model not available: ${model.id}`);
  }
  const providerModel = parseModelRef(model.id).model;
  const timeout = AbortSignal.timeout(SPEECH_TIMEOUT_MS);
  const pcm = await SPEECH_PROVIDER_ADAPTERS[model.provider].speak(
    apiKey,
    providerModel,
    voice,
    options.text,
    signal ? AbortSignal.any([signal, timeout]) : timeout
  );
  return encodeSpeech(withTrailingSilence(pcm, options.pauseSeconds ?? 0));
}
