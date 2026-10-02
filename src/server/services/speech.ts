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

/**
 * A cloud voice provider's catalog and synthesis. A provider is also an
 * `AiProvider` (`@/lib/ai/model-ref`), which is where its name and key live.
 */
interface SpeechProviderAdapter {
  /** The models the user can pick on these keys. */
  listModels(keys: AiProviderKeys | undefined): Promise<SpeechModel[]>;
  /**
   * `text` spoken by `voice` of `model` (provider-native ids), as MP3 streamed
   * as it's generated. Rejects when the provider refuses; checked as MP3 by
   * {@link checkedMp3Stream}.
   */
  speak(
    apiKey: string,
    model: string,
    voice: string,
    text: string,
    signal: AbortSignal
  ): Promise<ReadableStream<Uint8Array>>;
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
    SPEECH_PROVIDERS.filter((provider) => getProviderApiKey(provider, keys)).map(
      async (provider) => {
        try {
          return await SPEECH_PROVIDER_ADAPTERS[provider].listModels(keys);
        } catch (error) {
          logger.error("Failed to list speech models", {
            provider,
            error: error instanceof Error ? error.message : String(error),
          });
          unavailable.push(provider);
          return [];
        }
      }
    )
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
    const names = SPEECH_PROVIDERS.map((provider) => AI_PROVIDER_DISPLAY_NAMES[provider]);
    const providers = new Intl.ListFormat("en", { type: "disjunction" }).format(names);
    throw new SpeechRequestError(`Cloud voices require a ${providers} API key`);
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
/** ~15 minutes of 64 kbps MP3; a 1000-character chunk is about a minute. */
const MAX_SPEECH_BYTES = 8 * 1024 * 1024;

/**
 * Some models (MiMo) ignore `response_format` and send WAV, still labelled
 * `audio/mpeg`, so check the bytes: an ID3 tag or an MPEG frame sync.
 */
export function isMp3(audio: Uint8Array): boolean {
  const isId3 = audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33;
  const isFrameSync = audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0;
  return isId3 || isFrameSync;
}

/**
 * A provider's audio, checked: it must start like an MP3 and stay under
 * `maxBytes`. Resolves once the first bytes have arrived and passed, so a
 * provider that fails before sending audio is still an ordinary error;
 * failures after that error the stream.
 */
export async function checkedMp3Stream(
  body: ReadableStream<Uint8Array>,
  maxBytes = MAX_SPEECH_BYTES
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  let head = new Uint8Array(0);
  while (head.length < 3) {
    const { done, value } = await reader.read();
    if (done) break;
    const joined = new Uint8Array(head.length + value.length);
    joined.set(head);
    joined.set(value, head.length);
    head = joined;
  }
  if (!isMp3(head) || head.length > maxBytes) {
    await reader.cancel();
    throw new Error(head.length > maxBytes ? "Speech audio too large" : "Speech audio isn't MP3");
  }
  let pending: Uint8Array | null = head;
  let total = head.length;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending) {
        controller.enqueue(pending);
        pending = null;
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        controller.error(new Error("Speech audio too large"));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * `text` spoken as MP3, streamed as the provider generates it. A null model or
 * voice means the default. Rejects models the user can't pick in settings, so
 * this can't be used to run arbitrary (or arbitrarily expensive) models.
 * Aborting `signal` (the client went away) stops the provider's request.
 */
export async function streamSpeech(
  keys: AiProviderKeys,
  options: { model: string | null; voice: string | null; text: string },
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
  const body = await SPEECH_PROVIDER_ADAPTERS[model.provider].speak(
    apiKey,
    providerModel,
    voice,
    options.text,
    signal ? AbortSignal.any([signal, timeout]) : timeout
  );
  return checkedMp3Stream(body);
}

/** {@link streamSpeech}, read whole: for `narration.synthesize`, which installed apps still call. */
export async function synthesizeSpeech(
  keys: AiProviderKeys,
  options: { model: string | null; voice: string | null; text: string }
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(await streamSpeech(keys, options)).arrayBuffer());
}
