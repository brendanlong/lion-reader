/**
 * AudioBuffer Utilities
 *
 * Functions for manipulating AudioBuffers, including:
 * - Concatenating multiple buffers
 * - Adding silence gaps between buffers
 * - Getting buffer duration
 *
 * @module narration/audio-buffer-utils
 */

/**
 * Default silence gap between sentences in seconds.
 * This provides a natural pause between sentences.
 */
export const DEFAULT_SENTENCE_GAP_SECONDS = 0.3;

/**
 * Minimum pre-buffer duration in seconds.
 * We try to buffer at least this much audio ahead.
 */
export const MIN_PREBUFFER_DURATION_SECONDS = 5;

/**
 * Result of concatenating audio buffers, including metadata.
 */
export interface ConcatenatedAudio {
  /** The concatenated audio buffer */
  buffer: AudioBuffer;
  /** Duration of the buffer in seconds */
  duration: number;
  /** Offsets (in seconds) where each original buffer starts */
  offsets: number[];
}

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

/**
 * Concatenates multiple AudioBuffers with optional silence gaps between them.
 *
 * @param audioContext - The AudioContext to use
 * @param buffers - Array of AudioBuffers to concatenate
 * @param gapSeconds - Silence gap between buffers in seconds (default: 0.3)
 * @returns The concatenated audio with metadata
 */
export function concatenateAudioBuffers(
  audioContext: AudioContext,
  buffers: AudioBuffer[],
  gapSeconds: number = DEFAULT_SENTENCE_GAP_SECONDS
): ConcatenatedAudio {
  if (buffers.length === 0) {
    // Return an empty buffer
    const emptyBuffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
    return { buffer: emptyBuffer, duration: 0, offsets: [] };
  }

  if (buffers.length === 1) {
    return {
      buffer: buffers[0],
      duration: buffers[0].duration,
      offsets: [0],
    };
  }

  // Use the first buffer's properties as reference
  const sampleRate = buffers[0].sampleRate;
  const numberOfChannels = buffers[0].numberOfChannels;

  // Calculate total length including gaps
  const gapFrames = Math.ceil(sampleRate * gapSeconds);
  let totalFrames = 0;
  const offsets: number[] = [];

  for (let i = 0; i < buffers.length; i++) {
    offsets.push(totalFrames / sampleRate);
    totalFrames += buffers[i].length;
    if (i < buffers.length - 1) {
      totalFrames += gapFrames;
    }
  }

  // Create the output buffer
  const outputBuffer = audioContext.createBuffer(numberOfChannels, totalFrames, sampleRate);

  // Copy each input buffer into the output
  let currentFrame = 0;
  for (let i = 0; i < buffers.length; i++) {
    const inputBuffer = buffers[i];

    for (let channel = 0; channel < numberOfChannels; channel++) {
      const outputData = outputBuffer.getChannelData(channel);

      // If input has fewer channels, reuse channel 0
      const inputChannel = channel < inputBuffer.numberOfChannels ? channel : 0;
      const inputData = inputBuffer.getChannelData(inputChannel);

      outputData.set(inputData, currentFrame);
    }

    currentFrame += inputBuffer.length;

    // Add gap (silence is already zeros in the buffer)
    if (i < buffers.length - 1) {
      currentFrame += gapFrames;
    }
  }

  return {
    buffer: outputBuffer,
    duration: totalFrames / sampleRate,
    offsets,
  };
}

/**
 * Gets the duration of an AudioBuffer in seconds.
 *
 * @param buffer - The AudioBuffer
 * @returns Duration in seconds
 */
export function getAudioDuration(buffer: AudioBuffer): number {
  return buffer.duration;
}

/**
 * Calculates total duration of multiple AudioBuffers including gaps.
 *
 * @param buffers - Array of AudioBuffers
 * @param gapSeconds - Gap between buffers in seconds
 * @returns Total duration in seconds
 */
export function calculateTotalDuration(buffers: AudioBuffer[], gapSeconds: number = 0): number {
  if (buffers.length === 0) return 0;

  let total = 0;
  for (const buffer of buffers) {
    total += buffer.duration;
  }

  // Add gaps between buffers (not after the last one)
  if (buffers.length > 1) {
    total += gapSeconds * (buffers.length - 1);
  }

  return total;
}
