/**
 * Audio Encoder for Background-Compatible Playback
 *
 * Encodes PCM audio (from AudioBuffer) to Opus/WebM format using:
 * - WebCodecs API (AudioEncoder) for Opus encoding
 * - webm-muxer for container packaging
 *
 * This enables playback through HTMLAudioElement, which:
 * - Triggers Android media notifications via Media Session API
 * - Allows background playback when page is not in foreground
 * - Supports seeking (unlike AudioBufferSourceNode)
 *
 * @module narration/audio-encoder
 */

import { Muxer, ArrayBufferTarget } from "webm-muxer";

/**
 * Result of encoding audio.
 */
export interface EncodedAudio {
  /** The encoded audio as a Blob (WebM/Opus format) */
  blob: Blob;
  /** Object URL for the blob (for use with HTMLAudioElement) */
  url: string;
  /** Duration in seconds */
  duration: number;
}

/**
 * Check if WebCodecs AudioEncoder is supported.
 */
export function isAudioEncoderSupported(): boolean {
  return typeof AudioEncoder !== "undefined";
}

/**
 * Encode an AudioBuffer to WebM/Opus format.
 *
 * Uses WebCodecs API to encode PCM audio to Opus, then muxes into WebM container.
 *
 * @param audioBuffer - The PCM audio to encode
 * @param sampleRate - Sample rate for encoding (defaults to buffer's sample rate)
 * @returns Promise resolving to encoded audio with blob, url, and duration
 */
export async function encodeAudioBufferToWebM(
  audioBuffer: AudioBuffer,
  sampleRate?: number
): Promise<EncodedAudio> {
  const targetSampleRate = sampleRate ?? audioBuffer.sampleRate;
  const numberOfChannels = audioBuffer.numberOfChannels;

  // Create muxer targeting an ArrayBuffer
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: {
      codec: "A_OPUS",
      sampleRate: targetSampleRate,
      numberOfChannels,
    },
  });

  // Collect encoded chunks
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      muxer.addAudioChunk(chunk, meta ?? undefined);
    },
    error: (e) => {
      console.error("AudioEncoder error:", e);
    },
  });

  // Configure encoder for Opus
  await encoder.configure({
    codec: "opus",
    sampleRate: targetSampleRate,
    numberOfChannels,
    bitrate: 64000, // 64 kbps - good quality for speech
  });

  // Convert AudioBuffer to AudioData
  // Web Audio API uses f32-planar format
  const audioData = audioBufferToAudioData(audioBuffer);

  // Encode the audio
  encoder.encode(audioData);

  // Wait for encoding to complete
  await encoder.flush();
  encoder.close();
  audioData.close();

  // Finalize muxer and get the WebM data
  muxer.finalize();
  const target = muxer.target as ArrayBufferTarget;
  const webmBuffer = target.buffer;

  // Create blob and URL
  const blob = new Blob([webmBuffer], { type: "audio/webm; codecs=opus" });
  const url = URL.createObjectURL(blob);

  return {
    blob,
    url,
    duration: audioBuffer.duration,
  };
}

/**
 * Convert an AudioBuffer to AudioData for WebCodecs.
 *
 * AudioBuffer uses f32-planar format (separate Float32Array per channel).
 * We need to convert to interleaved format for AudioData.
 */
function audioBufferToAudioData(audioBuffer: AudioBuffer): AudioData {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const numberOfFrames = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;

  // For mono, use planar format directly
  // For stereo+, we need to interleave
  if (numberOfChannels === 1) {
    const channelData = audioBuffer.getChannelData(0);
    return new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames,
      numberOfChannels,
      timestamp: 0,
      data: channelData,
    });
  }

  // For multi-channel, create planar data with all channels concatenated
  const planarData = new Float32Array(numberOfFrames * numberOfChannels);
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    planarData.set(channelData, channel * numberOfFrames);
  }

  return new AudioData({
    format: "f32-planar",
    sampleRate,
    numberOfFrames,
    numberOfChannels,
    timestamp: 0,
    data: planarData,
  });
}

/**
 * Revoke a previously created object URL.
 *
 * Call this when done with an encoded audio URL to free memory.
 */
export function revokeAudioUrl(url: string): void {
  URL.revokeObjectURL(url);
}

/**
 * Encode multiple AudioBuffers and concatenate them into a single WebM file.
 *
 * This is useful for creating a continuous audio stream from multiple segments.
 *
 * @param audioBuffers - Array of AudioBuffers to concatenate and encode
 * @param gapSeconds - Silence gap between buffers (default: 0)
 * @returns Promise resolving to encoded audio
 */
export async function encodeAudioBuffersToWebM(
  audioBuffers: AudioBuffer[],
  gapSeconds: number = 0
): Promise<EncodedAudio> {
  if (audioBuffers.length === 0) {
    throw new Error("No audio buffers provided");
  }

  if (audioBuffers.length === 1) {
    return encodeAudioBufferToWebM(audioBuffers[0]);
  }

  // Get common properties from first buffer
  const sampleRate = audioBuffers[0].sampleRate;
  const numberOfChannels = audioBuffers[0].numberOfChannels;
  const gapSamples = Math.floor(gapSeconds * sampleRate);

  // Calculate total length
  let totalLength = 0;
  for (const buffer of audioBuffers) {
    totalLength += buffer.length;
  }
  totalLength += gapSamples * (audioBuffers.length - 1);

  // Create muxer
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: {
      codec: "A_OPUS",
      sampleRate,
      numberOfChannels,
    },
  });

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      muxer.addAudioChunk(chunk, meta ?? undefined);
    },
    error: (e) => {
      console.error("AudioEncoder error:", e);
    },
  });

  await encoder.configure({
    codec: "opus",
    sampleRate,
    numberOfChannels,
    bitrate: 64000,
  });

  // Encode each buffer with timestamp offset
  let timestampMicroseconds = 0;

  for (let i = 0; i < audioBuffers.length; i++) {
    const buffer = audioBuffers[i];
    const audioData = audioBufferToAudioDataWithTimestamp(buffer, timestampMicroseconds);
    encoder.encode(audioData);
    audioData.close();

    // Update timestamp for next buffer (including gap)
    const durationMicroseconds = (buffer.length / sampleRate) * 1_000_000;
    timestampMicroseconds += durationMicroseconds;

    // Add gap duration (except after last buffer)
    if (i < audioBuffers.length - 1 && gapSeconds > 0) {
      timestampMicroseconds += gapSeconds * 1_000_000;
    }
  }

  await encoder.flush();
  encoder.close();

  muxer.finalize();
  const target = muxer.target as ArrayBufferTarget;
  const webmBuffer = target.buffer;

  const blob = new Blob([webmBuffer], { type: "audio/webm; codecs=opus" });
  const url = URL.createObjectURL(blob);

  const totalDuration = totalLength / sampleRate;

  return {
    blob,
    url,
    duration: totalDuration,
  };
}

/**
 * Convert an AudioBuffer to AudioData with a specific timestamp.
 */
function audioBufferToAudioDataWithTimestamp(
  audioBuffer: AudioBuffer,
  timestampMicroseconds: number
): AudioData {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const numberOfFrames = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;

  if (numberOfChannels === 1) {
    const channelData = audioBuffer.getChannelData(0);
    return new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames,
      numberOfChannels,
      timestamp: timestampMicroseconds,
      data: channelData,
    });
  }

  const planarData = new Float32Array(numberOfFrames * numberOfChannels);
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    planarData.set(channelData, channel * numberOfFrames);
  }

  return new AudioData({
    format: "f32-planar",
    sampleRate,
    numberOfFrames,
    numberOfChannels,
    timestamp: timestampMicroseconds,
    data: planarData,
  });
}
