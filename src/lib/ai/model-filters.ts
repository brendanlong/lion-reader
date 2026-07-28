/**
 * Shared rules for deciding which of a provider's models are worth offering in
 * the summarization / narration model pickers.
 *
 * Every provider lists models we can't use for these features — audio and
 * moderation models, and (on OpenRouter, which aggregates hundreds) models
 * whose context window is far too small to hold an article. The predicates
 * here are pure so they can be unit-tested and shared across providers.
 */

/**
 * Minimum context window (in tokens) for a model to appear in the pickers.
 * Summarization feeds up to ~12k tokens of article text plus the prompt and
 * reserves several thousand output/reasoning tokens, so short-context models
 * (8k-context Gemma/older-Llama, small Qwen builds) can't summarize a full
 * article. Models whose context window a provider doesn't report are kept.
 */
export const MIN_CONTEXT_WINDOW = 32768;

/**
 * Whether a provider-native model ID looks like a chat model. Groq's model list
 * includes audio (whisper/TTS) and moderation models that can't do chat
 * completions; hide them from the pickers. TTS families don't all spell "tts"
 * in their IDs (Groq exposes Orpheus TTS as `canopylabs/orpheus-*`), so match
 * those families by name too.
 */
export function isChatModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    !lower.includes("whisper") &&
    !lower.includes("tts") &&
    !lower.includes("guard") &&
    !lower.includes("canopylabs") &&
    !lower.includes("orpheus")
  );
}
