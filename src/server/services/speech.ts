/**
 * Cloud voices: server-side text-to-speech through OpenRouter's speech models.
 * Keys stay on the server, so the browser gets audio from our API rather than
 * calling OpenRouter itself.
 */

import { formatModelRef, normalizeModelRef, parseModelRef } from "@/lib/ai/model-ref";
import {
  DEFAULT_CLOUD_VOICE_MODEL,
  DEFAULT_CLOUD_VOICES,
  SERVER_KEY_CLOUD_VOICE_MODELS,
} from "@/lib/narration/constants";
import {
  getProviderApiKey,
  isModelAllowed,
  type AiProviderKeys,
} from "@/server/services/ai-providers";
import {
  listOpenRouterModels,
  openRouterSpeech,
  pricePerMillionUnits,
  type OpenRouterModel,
} from "@/server/services/openrouter";

export interface SpeechModel {
  /** `provider:model` ref. */
  id: string;
  displayName: string;
  provider: "openrouter";
  voices: string[];
  /** USD per million input characters. */
  pricePerMillionCharacters?: number;
}

export async function listSpeechModels(keys?: AiProviderKeys): Promise<SpeechModel[]> {
  if (!getProviderApiKey("openrouter", keys)) {
    return [];
  }
  return toSpeechModels(await listOpenRouterModels("speech"), keys);
}

/**
 * Speech models the user can pick: those that list voices, limited to the
 * server-key allowlist when running on the server's key.
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
          voices,
          pricePerMillionCharacters: pricePerMillionCharacters(model),
        },
      ];
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
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

export function defaultVoiceFor(model: SpeechModel): string {
  const preferred = DEFAULT_CLOUD_VOICES[model.id];
  return preferred && model.voices.includes(preferred) ? preferred : model.voices[0];
}

export class SpeechRequestError extends Error {}

/**
 * Synthesizes `text` as MP3. A null model or voice means the default. Rejects
 * models the user can't pick in settings, so this can't be used to run
 * arbitrary (or arbitrarily expensive) models.
 */
export async function synthesizeSpeech(
  keys: AiProviderKeys,
  options: { model: string | null; voice: string | null; text: string }
): Promise<Uint8Array> {
  const apiKey = getProviderApiKey("openrouter", keys);
  if (!apiKey) {
    throw new SpeechRequestError("Cloud voices require an OpenRouter API key");
  }
  const modelId = normalizeModelRef(options.model ?? DEFAULT_CLOUD_VOICE_MODEL);
  const model = (await listSpeechModels(keys)).find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new SpeechRequestError(`Speech model not available: ${modelId}`);
  }
  // A stored voice the model no longer lists falls back to the default, the
  // same voice the settings page shows as selected.
  const voice =
    options.voice && model.voices.includes(options.voice) ? options.voice : defaultVoiceFor(model);
  return openRouterSpeech(apiKey, parseModelRef(model.id).model, voice, options.text);
}
