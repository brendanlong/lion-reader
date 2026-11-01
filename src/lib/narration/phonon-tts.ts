/**
 * Phonon running in the browser. We download the model and every voice into a
 * Cache Storage entry of our own, so whether they're downloaded is read from
 * what's stored; loading hands them to the package's worker as `blob:` URLs
 * (with the package's own cache off), once per page.
 *
 * @module narration/phonon-tts
 */

import type { PhononTTS } from "phonon-tts";
import { version as PHONON_TTS_VERSION } from "phonon-tts/package.json";
import {
  ENHANCED_VOICES,
  enhancedVoiceUrl,
  PHONON_DOWNLOAD_SIZE_BYTES,
  PHONON_MODEL_FILES,
} from "./enhanced-voices";
import type { PcmAudio } from "./audio-encoding";

const CACHE_NAME = "lion-reader-phonon";
/** Tells other tabs that the stored files changed. */
const CHANNEL_NAME = "lion-reader-phonon";

const FILE_URLS = [
  PHONON_MODEL_FILES.weights,
  PHONON_MODEL_FILES.tokenizer,
  PHONON_MODEL_FILES.config,
  ...ENHANCED_VOICES.map((voice) => enhancedVoiceUrl(voice.id)),
];

// ============================================================================
// Whether the files are stored, as an external store for React
// ============================================================================

export type PhononModelState = "checking" | "missing" | "downloaded";

let state: PhononModelState = "checking";
const stateListeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
let checks = 0;

async function storedUrls(cache: Cache): Promise<Set<string>> {
  return new Set((await cache.keys()).map((request) => request.url));
}

async function refreshState(): Promise<void> {
  const check = ++checks;
  let stored = false;
  try {
    const urls = await storedUrls(await caches.open(CACHE_NAME));
    stored = FILE_URLS.every((url) => urls.has(url));
  } catch {
    // No Cache Storage here (or it's blocked): nothing can be stored.
  }
  if (check !== checks) return;
  const next = stored ? "downloaded" : "missing";
  // Removed, maybe by another tab: free the model it loaded from them.
  if (next === "missing") unload();
  if (next === state) return;
  state = next;
  stateListeners.forEach((listener) => listener());
}

/** For `useSyncExternalStore`; the server snapshot is `"checking"`. */
export function subscribePhononModelState(listener: () => void): () => void {
  if (stateListeners.size === 0 && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => void refreshState();
  }
  stateListeners.add(listener);
  void refreshState();
  return () => {
    stateListeners.delete(listener);
    if (stateListeners.size === 0) {
      channel?.close();
      channel = null;
    }
  };
}

export function getPhononModelState(): PhononModelState {
  return state;
}

async function announceChange(): Promise<void> {
  if (typeof BroadcastChannel !== "undefined") {
    const announcer = new BroadcastChannel(CHANNEL_NAME);
    announcer.postMessage("changed");
    announcer.close();
  }
  await refreshState();
}

// ============================================================================
// Downloading and removing
// ============================================================================

/**
 * Downloads, removals and loads run one at a time, so none sees half of
 * another.
 */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/**
 * Downloads whatever of the model and voices isn't stored yet. `onProgress`
 * hears the fraction of the whole download this run has fetched.
 */
export function downloadPhononModel(onProgress?: (fraction: number) => void): Promise<void> {
  return serialized(async () => {
    if (typeof caches === "undefined") {
      throw new Error("This browser can only store the voice model on an HTTPS page");
    }
    const cache = await caches.open(CACHE_NAME);
    const stored = await storedUrls(cache);
    let loaded = 0;
    for (const url of FILE_URLS) {
      if (stored.has(url)) continue;
      const response = await fetch(url);
      if (!response.ok || !response.body) {
        throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
      }
      const [toStore, toCount] = response.body.tee();
      const storing = cache.put(url, new Response(toStore));
      // Awaited below; if the read fails first, its error is the one to report.
      storing.catch(() => {});
      const reader = toCount.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        loaded += chunk.value.length;
        onProgress?.(Math.min(loaded / PHONON_DOWNLOAD_SIZE_BYTES, 1));
      }
      await storing;
    }
    // Files from a model or voice commit we no longer use.
    for (const request of await cache.keys()) {
      if (!FILE_URLS.includes(request.url)) await cache.delete(request);
    }
    await announceChange();
  });
}

/** Frees the loaded model and deletes the stored files. */
export function removePhononModel(): Promise<void> {
  return serialized(async () => {
    unload();
    await caches.delete(CACHE_NAME);
    await announceChange();
  });
}

// ============================================================================
// Loading and synthesis
// ============================================================================

interface LoadedModel {
  tts: PhononTTS;
  /**
   * Kept while the model is loaded: the worker fetches a voice the first
   * time it speaks (preloading all of them adds seconds to every load).
   */
  voiceBlobUrls: string[];
}

let loading: Promise<LoadedModel> | null = null;

function release({ tts, voiceBlobUrls }: LoadedModel): void {
  tts.dispose();
  voiceBlobUrls.forEach((url) => URL.revokeObjectURL(url));
}

function unload(): void {
  const current = loading;
  loading = null;
  current?.then(release, () => {});
}

async function loadModel(): Promise<LoadedModel> {
  const cache = await caches.open(CACHE_NAME);
  const modelBlobUrls: string[] = [];
  const voiceBlobUrls: string[] = [];
  const blobUrl = async (url: string, keep: string[]): Promise<string> => {
    const response = await cache.match(url);
    if (!response) throw new Error("The enhanced voice model isn't downloaded");
    const blob = URL.createObjectURL(await response.blob());
    keep.push(blob);
    return blob;
  };
  try {
    const { PhononTTS } = await import("phonon-tts");
    const voices = Object.fromEntries(
      await Promise.all(
        ENHANCED_VOICES.map(async (voice) => [
          voice.id,
          await blobUrl(enhancedVoiceUrl(voice.id), voiceBlobUrls),
        ])
      )
    );
    const tts = await PhononTTS.load({
      lang: "en",
      model: {
        weights: { q8: await blobUrl(PHONON_MODEL_FILES.weights, modelBlobUrls) },
        tokenizer: await blobUrl(PHONON_MODEL_FILES.tokenizer, modelBlobUrls),
        config: await blobUrl(PHONON_MODEL_FILES.config, modelBlobUrls),
        voices,
      },
      voices: [],
      cache: false,
      // Served from our origin (scripts/copy-phonon-runtime.mjs): a worker
      // can't start from the CDN our chunks load from. Versioned, so a page
      // from before a deploy never talks to a newer worker.
      workerUrl: `${window.location.origin}/phonon/${PHONON_TTS_VERSION}/worker.js`,
    });
    return { tts, voiceBlobUrls };
  } catch (error) {
    voiceBlobUrls.forEach((url) => URL.revokeObjectURL(url));
    throw error;
  } finally {
    modelBlobUrls.forEach((url) => URL.revokeObjectURL(url));
  }
}

function startLoad(): Promise<LoadedModel> {
  const load: Promise<LoadedModel> = serialized(loadModel).then((loaded) => {
    // Another tab removed the files while this loaded.
    if (loading !== load) {
      release(loaded);
      throw new Error("The enhanced voice model was deleted");
    }
    return loaded;
  });
  load.catch(() => {
    if (loading === load) loading = null;
  });
  return load;
}

/** The downloaded model, loaded once per page and shared by every caller. */
export async function loadPhonon(): Promise<PhononTTS> {
  loading ??= startLoad();
  return (await loading).tts;
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
