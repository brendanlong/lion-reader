/**
 * Phonon running in the browser: one model, loaded once per page into the
 * package's worker and kept for every enhanced voice.
 *
 * @module narration/phonon-tts
 */

import type { LoadProgress, PhononTTS } from "phonon-tts";
import {
  ENHANCED_VOICES,
  enhancedVoiceUrl,
  PHONON_MODEL_FILES,
  PHONON_MODEL_SIZE_BYTES,
} from "./enhanced-voices";
import type { PcmAudio } from "./audio-encoding";

/**
 * Remembers that this browser finished downloading the model, so settings can
 * say so without loading it. The package keeps the files in the Cache API
 * under a name it doesn't document; if the browser evicts them, the next load
 * just downloads them again.
 */
const DOWNLOADED_KEY = "lion-reader-phonon-model";

let loading: Promise<PhononTTS> | null = null;
const progressListeners = new Set<(fraction: number) => void>();
const loadedBytes = new Map<string, number>();

function reportProgress({ file, loaded }: LoadProgress): void {
  if (file.startsWith("voice:")) return;
  loadedBytes.set(file, loaded);
  const total = [...loadedBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
  const fraction = Math.min(total / PHONON_MODEL_SIZE_BYTES, 1);
  progressListeners.forEach((listener) => listener(fraction));
}

const downloadedListeners = new Set<() => void>();

/** For `useSyncExternalStore` over {@link isPhononModelDownloaded}. */
export function subscribePhononModelDownloaded(listener: () => void): () => void {
  downloadedListeners.add(listener);
  return () => downloadedListeners.delete(listener);
}

function setDownloaded(downloaded: boolean): void {
  try {
    if (downloaded) localStorage.setItem(DOWNLOADED_KEY, PHONON_MODEL_FILES.weights);
    else localStorage.removeItem(DOWNLOADED_KEY);
  } catch {
    // Settings will offer the download again; it comes from the cache.
  }
  downloadedListeners.forEach((listener) => listener());
}

export function isPhononModelDownloaded(): boolean {
  try {
    return localStorage.getItem(DOWNLOADED_KEY) === PHONON_MODEL_FILES.weights;
  } catch {
    return false;
  }
}

/**
 * The loaded model, downloading it first if this browser hasn't. Every caller
 * shares one load; `onProgress` hears it as a fraction of the download.
 */
export async function loadPhonon(onProgress?: (fraction: number) => void): Promise<PhononTTS> {
  if (onProgress) progressListeners.add(onProgress);
  loading ??= (async () => {
    loadedBytes.clear();
    const { PhononTTS } = await import("phonon-tts");
    const tts = await PhononTTS.load({
      lang: "en",
      model: {
        weights: { q8: PHONON_MODEL_FILES.weights },
        tokenizer: PHONON_MODEL_FILES.tokenizer,
        config: PHONON_MODEL_FILES.config,
        voices: Object.fromEntries(ENHANCED_VOICES.map((v) => [v.id, enhancedVoiceUrl(v.id)])),
      },
      voices: [],
      // Served from our origin (scripts/copy-phonon-runtime.mjs): a worker
      // can't start from the CDN our chunks load from.
      workerUrl: `${window.location.origin}/phonon/worker.js`,
      onProgress: reportProgress,
    });
    setDownloaded(true);
    return tts;
  })().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  try {
    return await loading;
  } finally {
    if (onProgress) progressListeners.delete(onProgress);
  }
}

/** Frees the loaded model and deletes its downloaded files. */
export async function removePhononModel(): Promise<void> {
  const current = loading;
  loading = null;
  setDownloaded(false);
  (await current?.catch(() => null))?.dispose();
  const { clearCache } = await import("phonon-tts");
  await clearCache();
}

export async function synthesizePhonon(
  text: string,
  voiceId: string,
  signal?: AbortSignal
): Promise<PcmAudio> {
  const tts = await loadPhonon();
  const samples = await tts.synth(text, { voice: voiceId, signal });
  return { samples, sampleRate: tts.sampleRate };
}
