/**
 * The AI providers, and what the rest of the app needs to know about each.
 * Adding one is an entry here plus its implementation on the server: text in
 * `src/server/services/ai-providers.ts` (and `NARRATION_PROVIDERS` if it can
 * do narration's JSON preprocessing), cloud voices in
 * `src/server/services/speech.ts`. Key storage, the settings page and
 * availability follow from the entry; the privacy policy needs updating too.
 *
 * Shared between server services and the settings UI.
 */

export interface AiProviderInfo {
  displayName: string;
  /** Where a user gets an API key, and what one looks like. */
  keyUrl: string;
  keyPlaceholder: string;
  /** Used for text: summaries and narration text processing. */
  text: boolean;
  /** Used for cloud voices. */
  speech: boolean;
}

export const AI_PROVIDER_INFO = {
  anthropic: {
    displayName: "Anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-...",
    text: true,
    speech: false,
  },
  groq: {
    displayName: "Groq",
    keyUrl: "https://console.groq.com/keys",
    keyPlaceholder: "gsk_...",
    text: true,
    speech: false,
  },
  cerebras: {
    displayName: "Cerebras",
    keyUrl: "https://cloud.cerebras.ai/",
    keyPlaceholder: "csk-...",
    text: true,
    speech: false,
  },
  deepinfra: {
    displayName: "DeepInfra",
    keyUrl: "https://deepinfra.com/dash/api_keys",
    keyPlaceholder: "Your DeepInfra API key",
    text: false,
    speech: true,
  },
  openrouter: {
    displayName: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-...",
    text: true,
    speech: true,
  },
  breezeblue: {
    displayName: "BreezeBlue",
    keyUrl: "https://breezeblue.ai/app/developer/api-keys",
    keyPlaceholder: "Your BreezeBlue API key",
    text: false,
    speech: true,
  },
} as const satisfies Record<string, AiProviderInfo>;

export type AiProvider = keyof typeof AI_PROVIDER_INFO;

export const AI_PROVIDERS = Object.keys(AI_PROVIDER_INFO) as AiProvider[];

type ProviderWith<Flag extends "text" | "speech"> = {
  [P in AiProvider]: (typeof AI_PROVIDER_INFO)[P][Flag] extends true ? P : never;
}[AiProvider];

/** Providers used for text generation (summaries, narration preprocessing). */
export type TextAiProvider = ProviderWith<"text">;
/** Providers of cloud voices. */
export type SpeechProvider = ProviderWith<"speech">;

export function isTextAiProvider(provider: AiProvider): provider is TextAiProvider {
  return AI_PROVIDER_INFO[provider].text;
}

function isSpeechProvider(provider: AiProvider): provider is SpeechProvider {
  return AI_PROVIDER_INFO[provider].speech;
}

export const TEXT_AI_PROVIDERS = AI_PROVIDERS.filter(isTextAiProvider);
export const SPEECH_PROVIDERS = AI_PROVIDERS.filter(isSpeechProvider);

export function isAiProvider(value: string): value is AiProvider {
  return Object.hasOwn(AI_PROVIDER_INFO, value);
}

export function aiProviderName(provider: AiProvider): string {
  return AI_PROVIDER_INFO[provider].displayName;
}

/** "A, B, or C" */
export function aiProviderNames(providers: readonly AiProvider[]): string {
  return new Intl.ListFormat("en", { type: "disjunction" }).format(providers.map(aiProviderName));
}
