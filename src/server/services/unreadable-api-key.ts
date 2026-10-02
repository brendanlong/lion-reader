/**
 * A saved API key that no longer decrypts, in place of the key in
 * `AiProviderKeys` (kept apart from `ai-providers.ts` so `getUserApiKeys` can
 * produce it without loading the provider SDKs).
 *
 * The provider still counts as on the user's own key, so nothing falls back to
 * the server's: calls to it fail until the user enters the key again.
 */
export const UNREADABLE_API_KEY: unique symbol = Symbol("unreadable API key");
