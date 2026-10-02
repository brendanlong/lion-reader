/**
 * Cloud voices: server-side text-to-speech through the providers in
 * {@link SPEECH_PROVIDER_ADAPTERS}. Keys stay on the server, so the browser
 * gets audio from our API rather than calling a provider itself.
 */

import {
  AI_PROVIDER_DISPLAY_NAMES,
  formatModelRef,
  normalizeModelRef,
  parseModelRef,
} from "@/lib/ai/model-ref";
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
  deepInfraSpeech,
  listDeepInfraSpeechModels,
  type DeepInfraSpeechModel,
} from "@/server/services/deepinfra";
import {
  listOpenRouterModels,
  openRouterSpeech,
  pricePerMillionUnits,
  type OpenRouterModel,
} from "@/server/services/openrouter";

export const SPEECH_PROVIDERS = ["deepinfra", "openrouter"] as const;

export type SpeechProvider = (typeof SPEECH_PROVIDERS)[number];

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

/** A cloud voice provider: everything the rest of the app needs from one. */
interface SpeechProviderAdapter {
  /** The models the user can pick on these keys. */
  listModels(keys: AiProviderKeys | undefined): Promise<SpeechModel[]>;
  /** `text` spoken by `voice` of `model` (provider-native ids), as MP3. */
  synthesize(apiKey: string, model: string, voice: string, text: string): Promise<Uint8Array>;
}

const SPEECH_PROVIDER_ADAPTERS: Record<SpeechProvider, SpeechProviderAdapter> = {
  deepinfra: {
    listModels: async (keys) => toDeepInfraSpeechModels(await listDeepInfraSpeechModels(), keys),
    synthesize: deepInfraSpeech,
  },
  openrouter: {
    listModels: async (keys) => toSpeechModels(await listOpenRouterModels("speech"), keys),
    synthesize: openRouterSpeech,
  },
};

function voicesNamedById(ids: string[]): SpeechVoice[] {
  return ids.map((id) => ({ id, name: id }));
}

/**
 * Speech models the user can pick, across the providers that have a key. A
 * provider whose catalog can't be fetched is logged and left out, so the
 * others still show up.
 */
export async function listSpeechModels(keys?: AiProviderKeys): Promise<SpeechModel[]> {
  const lists = await Promise.all(
    SPEECH_PROVIDERS.filter((provider) => getProviderApiKey(provider, keys)).map(
      async (provider) => {
        try {
          return await SPEECH_PROVIDER_ADAPTERS[provider].listModels(keys);
        } catch (error) {
          logger.error("Failed to list speech models", {
            provider,
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      }
    )
  );
  return lists.flat().sort(byDisplayName);
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

/** Display names for the voices whose name isn't their id, by id. */
export function voiceNamesFor(model: SpeechModel): Record<string, string> {
  return Object.fromEntries(
    model.voices.filter((voice) => voice.name !== voice.id).map((voice) => [voice.id, voice.name])
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
  models: SpeechModel[],
  keys: AiProviderKeys,
  requestedModel: string | null,
  requestedVoice: string | null
): { model: SpeechModel; voice: string } {
  if (models.length === 0) {
    const names = SPEECH_PROVIDERS.map((provider) => AI_PROVIDER_DISPLAY_NAMES[provider]);
    const providers = new Intl.ListFormat("en", { type: "disjunction" }).format(names);
    throw new SpeechRequestError(`Cloud voices require a ${providers} API key`);
  }
  const requested = requestedModel ? normalizeModelRef(requestedModel) : null;
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

/**
 * Synthesizes `text` as MP3. A null model or voice means the default. Rejects
 * models the user can't pick in settings, so this can't be used to run
 * arbitrary (or arbitrarily expensive) models.
 */
export async function synthesizeSpeech(
  keys: AiProviderKeys,
  options: { model: string | null; voice: string | null; text: string }
): Promise<Uint8Array> {
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
  return SPEECH_PROVIDER_ADAPTERS[model.provider].synthesize(
    apiKey,
    providerModel,
    voice,
    options.text
  );
}
