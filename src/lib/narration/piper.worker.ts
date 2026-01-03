/**
 * Piper TTS Web Worker
 *
 * Handles CPU-intensive Piper TTS operations in a background thread
 * to prevent blocking the main UI thread.
 *
 * Operations handled:
 * - Voice download with progress reporting
 * - Audio generation (ONNX inference)
 * - Voice storage management
 *
 * @module narration/piper.worker
 */

// Type definitions for the piper-tts-web module
interface PiperTTS {
  TtsSession: {
    create: (options: {
      voiceId: string;
      wasmPaths: {
        onnxWasm: string;
        piperData: string;
        piperWasm: string;
      };
    }) => Promise<{ predict: (text: string) => Promise<Blob> }>;
    _instance: unknown | null;
  };
  download: (
    voiceId: string,
    onProgress: (progress: { loaded: number; total: number }) => void
  ) => Promise<void>;
  remove: (voiceId: string) => Promise<void>;
  stored: () => Promise<string[]>;
}

/**
 * Custom WASM paths configuration.
 * We serve ONNX WASM files locally because the default CDN URL is broken.
 * Piper WASM files are served from jsdelivr which works correctly.
 */
const CUSTOM_WASM_PATHS = {
  onnxWasm: "/onnx/",
  piperData:
    "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data",
  piperWasm:
    "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm",
};

/**
 * Tracks the voice ID currently loaded in the TtsSession singleton.
 */
let currentlyLoadedVoiceId: string | null = null;

/**
 * Cached piper module reference.
 */
let piperModule: PiperTTS | null = null;

/**
 * Dynamically imports the piper-tts-web module.
 */
async function getPiperTTS(): Promise<PiperTTS> {
  if (!piperModule) {
    piperModule = (await import("@mintplex-labs/piper-tts-web")) as PiperTTS;
  }
  return piperModule;
}

/**
 * Resets the TtsSession singleton if a different voice is requested.
 */
async function ensureCorrectVoiceLoaded(piper: PiperTTS, voiceId: string): Promise<void> {
  if (currentlyLoadedVoiceId !== null && currentlyLoadedVoiceId !== voiceId) {
    piper.TtsSession._instance = null;
  }
  currentlyLoadedVoiceId = voiceId;
}

// Message types from main thread to worker
export type WorkerRequest =
  | { type: "getStoredVoiceIds"; id: number }
  | { type: "downloadVoice"; id: number; voiceId: string }
  | { type: "removeVoice"; id: number; voiceId: string }
  | { type: "generateAudio"; id: number; text: string; voiceId: string };

// Message types from worker to main thread
export type WorkerResponse =
  | { type: "storedVoiceIds"; id: number; voiceIds: string[] }
  | { type: "downloadProgress"; id: number; progress: number }
  | { type: "downloadComplete"; id: number }
  | { type: "removeComplete"; id: number }
  | { type: "audioGenerated"; id: number; audioData: ArrayBuffer }
  | { type: "error"; id: number; error: string };

/**
 * Handle messages from the main thread.
 */
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    switch (request.type) {
      case "getStoredVoiceIds": {
        const piper = await getPiperTTS();
        const voiceIds = await piper.stored();
        self.postMessage({
          type: "storedVoiceIds",
          id: request.id,
          voiceIds,
        } satisfies WorkerResponse);
        break;
      }

      case "downloadVoice": {
        const piper = await getPiperTTS();
        await piper.download(request.voiceId, (progress) => {
          if (progress.total > 0) {
            self.postMessage({
              type: "downloadProgress",
              id: request.id,
              progress: progress.loaded / progress.total,
            } satisfies WorkerResponse);
          }
        });
        self.postMessage({
          type: "downloadComplete",
          id: request.id,
        } satisfies WorkerResponse);
        break;
      }

      case "removeVoice": {
        const piper = await getPiperTTS();
        await piper.remove(request.voiceId);
        self.postMessage({
          type: "removeComplete",
          id: request.id,
        } satisfies WorkerResponse);
        break;
      }

      case "generateAudio": {
        const piper = await getPiperTTS();

        // Ensure the correct voice model is loaded
        await ensureCorrectVoiceLoaded(piper, request.voiceId);

        const session = await piper.TtsSession.create({
          voiceId: request.voiceId,
          wasmPaths: CUSTOM_WASM_PATHS,
        });

        const wavBlob = await session.predict(request.text);
        const audioData = await wavBlob.arrayBuffer();

        // Transfer the ArrayBuffer to avoid copying
        self.postMessage(
          {
            type: "audioGenerated",
            id: request.id,
            audioData,
          } satisfies WorkerResponse,
          { transfer: [audioData] }
        );
        break;
      }
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse);
  }
};

// Let the main thread know the worker is ready
self.postMessage({ type: "ready" });
