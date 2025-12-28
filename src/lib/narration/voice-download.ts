/**
 * Voice download manager for Piper TTS voices.
 *
 * This module handles downloading voice models from HuggingFace
 * with progress tracking and storage in IndexedDB.
 *
 * @module narration/voice-download
 */

import { findEnhancedVoice, type EnhancedVoice } from "./enhanced-voices";
import { VoiceCache } from "./voice-cache";

/**
 * Base URL for Piper voice models on HuggingFace.
 */
const HUGGINGFACE_BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

/**
 * Current version string for cached voices.
 * Increment this when voice model format changes to invalidate old caches.
 */
const VOICE_CACHE_VERSION = "1.0";

/**
 * Error thrown when a voice download fails.
 */
export class VoiceDownloadError extends Error {
  constructor(
    message: string,
    public readonly voiceId: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "VoiceDownloadError";
  }
}

/**
 * Progress callback for download operations.
 *
 * @param progress - Download progress from 0 to 1 (0% to 100%).
 */
export type ProgressCallback = (progress: number) => void;

/**
 * URLs for downloading a voice model and its configuration.
 */
export interface VoiceDownloadUrls {
  /**
   * URL to the .onnx model file.
   */
  modelUrl: string;

  /**
   * URL to the .onnx.json configuration file.
   */
  configUrl: string;
}

/**
 * Constructs the HuggingFace URLs for downloading a voice model.
 *
 * Voice files are organized in HuggingFace with the following pattern:
 * `{lang}/{lang}_{REGION}/{speaker}/{quality}/{voiceId}.onnx`
 *
 * For example, for voice ID "en_US-lessac-medium":
 * - Language: "en"
 * - Region: "US"
 * - Speaker: "lessac"
 * - Quality: "medium"
 * - Path: "en/en_US/lessac/medium/en_US-lessac-medium.onnx"
 *
 * @param voiceId - The voice ID (e.g., "en_US-lessac-medium").
 * @returns Object containing model and config URLs.
 * @throws Error if the voice ID format is invalid.
 *
 * @example
 * ```ts
 * const urls = getVoiceDownloadUrls("en_US-lessac-medium");
 * console.log(urls.modelUrl);
 * // "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx"
 * ```
 */
export function getVoiceDownloadUrls(voiceId: string): VoiceDownloadUrls {
  // Parse the voice ID: format is "{lang}_{REGION}-{speaker}-{quality}"
  // Examples: "en_US-lessac-medium", "en_GB-alba-medium", "en_AU-karen-medium"
  const match = voiceId.match(/^([a-z]{2})_([A-Z]{2})-([a-z]+)-([a-z]+)$/);

  if (!match) {
    throw new Error(
      `Invalid voice ID format: ${voiceId}. Expected format: "xx_XX-speaker-quality"`
    );
  }

  const [, lang, region, speaker, quality] = match;

  // Construct the path: {lang}/{lang}_{REGION}/{speaker}/{quality}
  const modelPath = `${lang}/${lang}_${region}/${speaker}/${quality}`;

  return {
    modelUrl: `${HUGGINGFACE_BASE_URL}/${modelPath}/${voiceId}.onnx`,
    configUrl: `${HUGGINGFACE_BASE_URL}/${modelPath}/${voiceId}.onnx.json`,
  };
}

/**
 * Fetches a resource with progress tracking.
 *
 * Uses the Fetch API with ReadableStream to track download progress.
 * Falls back to regular fetch if ReadableStream is not supported.
 *
 * @param url - The URL to fetch.
 * @param onProgress - Callback called with progress (0 to 1).
 * @returns Promise resolving to the response data as ArrayBuffer.
 * @throws Error if the fetch fails or response is not OK.
 *
 * @example
 * ```ts
 * const data = await fetchWithProgress(
 *   "https://example.com/file.bin",
 *   (progress) => console.log(`${Math.round(progress * 100)}%`)
 * );
 * ```
 */
export async function fetchWithProgress(
  url: string,
  onProgress?: ProgressCallback
): Promise<ArrayBuffer> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  // Get the content length for progress calculation
  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

  // If no content length or no body, fall back to simple arrayBuffer()
  if (!totalBytes || !response.body) {
    const data = await response.arrayBuffer();
    onProgress?.(1);
    return data;
  }

  // Read the stream with progress tracking
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(value);
    receivedBytes += value.length;

    // Report progress
    onProgress?.(receivedBytes / totalBytes);
  }

  // Combine all chunks into a single ArrayBuffer
  const result = new Uint8Array(receivedBytes);
  let position = 0;

  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.length;
  }

  return result.buffer;
}

/**
 * Downloads a Piper voice model and stores it in IndexedDB.
 *
 * Downloads both the .onnx model file and .onnx.json configuration,
 * then stores them in the voice cache for offline use.
 *
 * @param voiceId - The voice ID to download (e.g., "en_US-lessac-medium").
 * @param onProgress - Optional callback for download progress (0 to 1).
 * @param voiceCache - Optional VoiceCache instance (creates new one if not provided).
 * @throws VoiceDownloadError if the voice is unknown or download fails.
 *
 * @example
 * ```ts
 * try {
 *   await downloadVoice("en_US-lessac-medium", (progress) => {
 *     console.log(`Download: ${Math.round(progress * 100)}%`);
 *   });
 *   console.log("Download complete!");
 * } catch (error) {
 *   if (error instanceof VoiceDownloadError) {
 *     console.error(`Failed to download ${error.voiceId}: ${error.message}`);
 *   }
 * }
 * ```
 */
export async function downloadVoice(
  voiceId: string,
  onProgress?: ProgressCallback,
  voiceCache?: VoiceCache
): Promise<void> {
  // Validate that this is a known enhanced voice
  const voice = findEnhancedVoice(voiceId);

  if (!voice) {
    throw new VoiceDownloadError(`Unknown voice: ${voiceId}`, voiceId);
  }

  // Get download URLs
  const urls = getVoiceDownloadUrls(voiceId);

  // Create or use provided cache
  const cache = voiceCache ?? new VoiceCache();

  try {
    // Download the model file with progress tracking
    // The model is the large file (~17-50 MB), so we track its progress
    const modelData = await fetchWithProgress(urls.modelUrl, onProgress).catch((error: Error) => {
      throw new VoiceDownloadError(`Failed to download model: ${error.message}`, voiceId, error);
    });

    // Download the config file (small, no progress needed)
    const configResponse = await fetch(urls.configUrl).catch((error: Error) => {
      throw new VoiceDownloadError(`Failed to download config: ${error.message}`, voiceId, error);
    });

    if (!configResponse.ok) {
      throw new VoiceDownloadError(
        `Failed to download config: HTTP ${configResponse.status}`,
        voiceId
      );
    }

    const configData = await configResponse.text();

    // Store in IndexedDB
    await cache.put({
      voiceId,
      modelData,
      configData,
      downloadedAt: Date.now(),
      version: VOICE_CACHE_VERSION,
    });

    // Ensure progress shows 100% on completion
    onProgress?.(1);
  } catch (error) {
    // Re-throw VoiceDownloadError as-is
    if (error instanceof VoiceDownloadError) {
      throw error;
    }

    // Wrap other errors
    throw new VoiceDownloadError(
      error instanceof Error ? error.message : "Unknown error",
      voiceId,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Checks if a voice is already downloaded and cached.
 *
 * @param voiceId - The voice ID to check.
 * @param voiceCache - Optional VoiceCache instance.
 * @returns Promise resolving to true if the voice is cached.
 *
 * @example
 * ```ts
 * const isDownloaded = await isVoiceDownloaded("en_US-lessac-medium");
 * if (!isDownloaded) {
 *   await downloadVoice("en_US-lessac-medium", onProgress);
 * }
 * ```
 */
export async function isVoiceDownloaded(
  voiceId: string,
  voiceCache?: VoiceCache
): Promise<boolean> {
  const cache = voiceCache ?? new VoiceCache();
  const entry = await cache.get(voiceId);
  return entry !== undefined;
}

/**
 * Deletes a downloaded voice from the cache.
 *
 * @param voiceId - The voice ID to delete.
 * @param voiceCache - Optional VoiceCache instance.
 * @returns Promise resolving to true if the voice was deleted.
 *
 * @example
 * ```ts
 * const wasDeleted = await deleteDownloadedVoice("en_US-lessac-medium");
 * if (wasDeleted) {
 *   console.log("Voice removed from cache");
 * }
 * ```
 */
export async function deleteDownloadedVoice(
  voiceId: string,
  voiceCache?: VoiceCache
): Promise<boolean> {
  const cache = voiceCache ?? new VoiceCache();
  return cache.delete(voiceId);
}

/**
 * Gets a list of all downloaded voices with their metadata.
 *
 * @param voiceCache - Optional VoiceCache instance.
 * @returns Promise resolving to array of downloaded enhanced voices.
 *
 * @example
 * ```ts
 * const downloaded = await getDownloadedVoices();
 * for (const voice of downloaded) {
 *   console.log(`${voice.displayName} - downloaded`);
 * }
 * ```
 */
export async function getDownloadedVoices(voiceCache?: VoiceCache): Promise<EnhancedVoice[]> {
  const cache = voiceCache ?? new VoiceCache();
  const entries = await cache.list();

  // Filter to only return enhanced voices that we know about
  return entries
    .map((entry) => findEnhancedVoice(entry.voiceId))
    .filter((voice): voice is EnhancedVoice => voice !== undefined);
}
