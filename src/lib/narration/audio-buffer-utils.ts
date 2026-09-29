/**
 * AudioBuffer Utilities
 *
 * Silence helpers for the sentence gaps between Piper audio buffers.
 *
 * @module narration/audio-buffer-utils
 */

/**
 * Default silence gap between sentences in seconds.
 * This provides a natural pause between sentences.
 */
export const DEFAULT_SENTENCE_GAP_SECONDS = 0.1;

/**
 * Creates a silent AudioBuffer of the specified duration.
 *
 * @param audioContext - The AudioContext to use
 * @param durationSeconds - Duration of silence in seconds
 * @param sampleRate - Sample rate (defaults to context's sample rate)
 * @param numberOfChannels - Number of audio channels (defaults to 1 for mono)
 * @returns A silent AudioBuffer
 */
export function createSilence(
  audioContext: AudioContext,
  durationSeconds: number,
  sampleRate?: number,
  numberOfChannels = 1
): AudioBuffer {
  const rate = sampleRate ?? audioContext.sampleRate;
  const frameCount = Math.ceil(rate * durationSeconds);

  // Create an empty buffer (all zeros = silence)
  return audioContext.createBuffer(numberOfChannels, frameCount, rate);
}
