/**
 * Voice selection utilities for the narration feature.
 *
 * These utilities help with discovering, filtering, and ranking
 * available speech synthesis voices in the browser.
 */

/**
 * Gets available speech synthesis voices, optionally filtered by language.
 *
 * @param lang - Language prefix to filter by (default: 'en' for English).
 *               Pass empty string to get all voices.
 * @returns Array of available voices matching the language filter.
 *
 * @example
 * ```ts
 * // Get all English voices
 * const englishVoices = getAvailableVoices();
 *
 * // Get all Spanish voices
 * const spanishVoices = getAvailableVoices('es');
 *
 * // Get all voices regardless of language
 * const allVoices = getAvailableVoices('');
 * ```
 */
function getAvailableVoices(lang: string = "en"): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return [];
  }

  const voices = speechSynthesis.getVoices();

  if (!lang) {
    return voices;
  }

  return voices.filter((voice) => voice.lang.startsWith(lang));
}

/**
 * Waits for voices to be loaded and returns available voices.
 *
 * In some browsers (especially Chrome), voices load asynchronously
 * after the page loads. This function handles both sync and async
 * voice loading patterns.
 *
 * @param lang - Language prefix to filter by (default: 'en' for English).
 * @param timeout - Maximum time to wait for voices in ms (default: 5000).
 * @returns Promise resolving to array of available voices.
 *
 * @example
 * ```ts
 * // Wait for voices to load
 * const voices = await waitForVoices();
 * console.log(`Found ${voices.length} English voices`);
 * ```
 */
export function waitForVoices(
  lang: string = "en",
  timeout: number = 5000
): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    // Check if running in browser
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve([]);
      return;
    }

    // Try to get voices immediately (works in Firefox and Safari)
    const voices = getAvailableVoices(lang);
    if (voices.length > 0) {
      resolve(voices);
      return;
    }

    // Set up timeout to avoid hanging forever
    const timeoutId = setTimeout(() => {
      speechSynthesis.onvoiceschanged = null;
      resolve(getAvailableVoices(lang));
    }, timeout);

    // Wait for voices to load (needed in Chrome)
    speechSynthesis.onvoiceschanged = () => {
      clearTimeout(timeoutId);
      speechSynthesis.onvoiceschanged = null;
      resolve(getAvailableVoices(lang));
    };
  });
}

/**
 * Ranks voices by quality using a heuristic.
 *
 * The ranking prioritizes:
 * 1. Non-default voices (often higher quality neural voices)
 * 2. Local voices over remote (lower latency, works offline)
 * 3. Alphabetical by name as a tiebreaker
 *
 * @param voices - Array of voices to rank.
 * @returns New array sorted by quality (best first).
 *
 * @example
 * ```ts
 * const voices = await waitForVoices();
 * const rankedVoices = rankVoices(voices);
 * // Use the best voice
 * const bestVoice = rankedVoices[0];
 * ```
 */
export function rankVoices(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  return [...voices].sort((a, b) => {
    // Prefer non-default voices (often higher quality)
    if (a.default !== b.default) {
      return a.default ? 1 : -1;
    }

    // Prefer local voices over remote (lower latency, offline support)
    if (a.localService !== b.localService) {
      return a.localService ? -1 : 1;
    }

    // Alphabetical fallback for consistent ordering
    return a.name.localeCompare(b.name);
  });
}

/**
 * Finds a voice by its unique voice URI.
 *
 * Voice URIs are stable identifiers that can be stored in user preferences.
 * This function retrieves the actual voice object from a stored URI.
 *
 * @param uri - The voiceURI to search for.
 * @returns The matching voice, or null if not found.
 *
 * @example
 * ```ts
 * // Restore user's preferred voice from settings
 * const savedUri = localStorage.getItem('preferredVoiceUri');
 * if (savedUri) {
 *   const voice = findVoiceByUri(savedUri);
 *   if (voice) {
 *     utterance.voice = voice;
 *   }
 * }
 * ```
 */
export function findVoiceByUri(uri: string): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return null;
  }

  const voices = speechSynthesis.getVoices();
  return voices.find((voice) => voice.voiceURI === uri) ?? null;
}
