/**
 * The AI providers, and what the rest of the app needs to know about each.
 * Adding one is an entry here plus its implementation on the server: text in
 * `src/server/services/ai-providers.ts` (and `NARRATION_PROVIDERS` if it can
 * do narration's JSON preprocessing), cloud voices in
 * `src/server/services/speech.ts`. Key storage, the settings page and
 * availability follow from the entry; the privacy policy needs updating too
 * (`tests/unit/privacy-policy.test.tsx` checks it links a third party's policy).
 *
 * Shared between server services and the settings UI.
 */

export interface AiProviderInfo {
  displayName: string;
  /**
   * Where a user gets their own API key, and what one looks like; null when
   * only the server has one (the provider is the operator's own).
   */
  userKey: { url: string; placeholder: string } | null;
  /**
   * Linked from our privacy policy wherever we say we send this provider data;
   * null for the operator's own.
   */
  privacyPolicyUrl: string | null;
  /** Used for text: summaries and narration text processing. */
  text: boolean;
  /** Used for cloud voices. */
  speech: boolean;
}

export const AI_PROVIDER_INFO = {
  anthropic: {
    displayName: "Anthropic",
    userKey: { url: "https://console.anthropic.com/settings/keys", placeholder: "sk-ant-..." },
    privacyPolicyUrl: "https://www.anthropic.com/legal/privacy",
    text: true,
    speech: false,
  },
  cerebras: {
    displayName: "Cerebras",
    userKey: { url: "https://cloud.cerebras.ai/", placeholder: "csk-..." },
    privacyPolicyUrl: "https://www.cerebras.ai/privacy-policy",
    text: true,
    speech: false,
  },
  deepinfra: {
    displayName: "DeepInfra",
    userKey: { url: "https://deepinfra.com/dash/api_keys", placeholder: "Your DeepInfra API key" },
    privacyPolicyUrl: "https://deepinfra.com/privacy",
    text: false,
    speech: true,
  },
  openrouter: {
    displayName: "OpenRouter",
    userKey: { url: "https://openrouter.ai/settings/keys", placeholder: "sk-or-..." },
    privacyPolicyUrl: "https://openrouter.ai/privacy",
    text: true,
    speech: true,
  },
  breezeblue: {
    displayName: "BreezeBlue",
    userKey: {
      url: "https://breezeblue.ai/app/developer/api-keys",
      placeholder: "Your BreezeBlue API key",
    },
    privacyPolicyUrl: "https://breezeblue.ai/legal/privacy",
    text: false,
    speech: true,
  },
  together: {
    displayName: "Together AI",
    userKey: {
      url: "https://api.together.ai/settings/api-keys",
      placeholder: "Your Together AI API key",
    },
    privacyPolicyUrl: "https://www.together.ai/privacy",
    text: false,
    speech: true,
  },
  /** The operator's own speech server (`src/server/services/selfhosted.ts`). */
  selfhosted: {
    displayName: "Lion Reader",
    userKey: null,
    privacyPolicyUrl: null,
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

export function isSpeechProvider(provider: AiProvider): provider is SpeechProvider {
  return AI_PROVIDER_INFO[provider].speech;
}

export const TEXT_AI_PROVIDERS = AI_PROVIDERS.filter(isTextAiProvider);
export const SPEECH_PROVIDERS = AI_PROVIDERS.filter(isSpeechProvider);

/** Providers a user can add their own API key for. */
export type UserKeyProvider = {
  [P in AiProvider]: (typeof AI_PROVIDER_INFO)[P]["userKey"] extends null ? never : P;
}[AiProvider];

export function isUserKeyProvider(value: string): value is UserKeyProvider {
  return isAiProvider(value) && AI_PROVIDER_INFO[value].userKey !== null;
}

export const USER_KEY_PROVIDERS = AI_PROVIDERS.filter(isUserKeyProvider);

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
