/**
 * Piper Worker Client
 *
 * Provides a promise-based API for communicating with the Piper TTS Web Worker.
 * Handles message routing, request/response correlation, and worker lifecycle.
 *
 * @module narration/piper-worker-client
 */

import type { WorkerRequest, WorkerResponse } from "./piper.worker";

/**
 * Pending request with resolve/reject callbacks.
 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: number) => void;
}

/**
 * Client for communicating with the Piper TTS Web Worker.
 *
 * Provides a promise-based API that handles message routing and correlation.
 */
export class PiperWorkerClient {
  private worker: Worker | null = null;
  private pendingRequests: Map<number, PendingRequest> = new Map();
  private nextRequestId = 1;
  private workerReady: Promise<void>;
  private resolveWorkerReady!: () => void;
  private initError: Error | null = null;

  constructor() {
    this.workerReady = new Promise((resolve) => {
      this.resolveWorkerReady = resolve;
    });

    this.initWorker();
  }

  /**
   * Initialize the web worker.
   */
  private initWorker(): void {
    try {
      // Create worker using the URL constructor pattern for Next.js compatibility
      this.worker = new Worker(new URL("./piper.worker.ts", import.meta.url), {
        type: "module",
      });

      this.worker.onmessage = (event: MessageEvent<WorkerResponse | { type: "ready" }>) => {
        this.handleMessage(event.data);
      };

      this.worker.onerror = (error) => {
        console.error("Piper worker error:", error);
        this.initError = new Error(`Worker error: ${error.message}`);
        // Reject all pending requests
        for (const [id, request] of this.pendingRequests) {
          request.reject(this.initError);
          this.pendingRequests.delete(id);
        }
      };
    } catch (error) {
      this.initError = error instanceof Error ? error : new Error(String(error));
      console.error("Failed to initialize Piper worker:", this.initError);
    }
  }

  /**
   * Handle messages from the worker.
   */
  private handleMessage(response: WorkerResponse | { type: "ready" }): void {
    if (response.type === "ready") {
      this.resolveWorkerReady();
      return;
    }

    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn("Received response for unknown request:", response.id);
      return;
    }

    switch (response.type) {
      case "storedVoiceIds":
        pending.resolve(response.voiceIds);
        this.pendingRequests.delete(response.id);
        break;

      case "downloadProgress":
        pending.onProgress?.(response.progress);
        // Don't delete - wait for downloadComplete
        break;

      case "downloadComplete":
        pending.resolve(undefined);
        this.pendingRequests.delete(response.id);
        break;

      case "removeComplete":
        pending.resolve(undefined);
        this.pendingRequests.delete(response.id);
        break;

      case "audioGenerated":
        pending.resolve(response.audioData);
        this.pendingRequests.delete(response.id);
        break;

      case "error":
        pending.reject(new Error(response.error));
        this.pendingRequests.delete(response.id);
        break;
    }
  }

  /**
   * Send a request to the worker and wait for the response.
   */
  private async sendRequest<T>(
    request: { type: string; [key: string]: unknown },
    onProgress?: (progress: number) => void
  ): Promise<T> {
    // Wait for worker to be ready
    await this.workerReady;

    if (this.initError) {
      throw this.initError;
    }

    if (!this.worker) {
      throw new Error("Piper worker not initialized");
    }

    const id = this.nextRequestId++;

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress,
      });

      this.worker!.postMessage({ ...request, id } as WorkerRequest);
    });
  }

  /**
   * Get the list of stored voice IDs.
   */
  async getStoredVoiceIds(): Promise<string[]> {
    return this.sendRequest<string[]>({ type: "getStoredVoiceIds" });
  }

  /**
   * Download a voice model.
   *
   * @param voiceId - The voice ID to download.
   * @param onProgress - Optional callback for download progress (0-1).
   */
  async downloadVoice(voiceId: string, onProgress?: (progress: number) => void): Promise<void> {
    return this.sendRequest<void>({ type: "downloadVoice", voiceId }, onProgress);
  }

  /**
   * Remove a downloaded voice.
   *
   * @param voiceId - The voice ID to remove.
   */
  async removeVoice(voiceId: string): Promise<void> {
    return this.sendRequest<void>({ type: "removeVoice", voiceId });
  }

  /**
   * Generate audio from text.
   *
   * @param text - The text to synthesize.
   * @param voiceId - The voice ID to use.
   * @returns The audio data as an ArrayBuffer (WAV format).
   */
  async generateAudio(text: string, voiceId: string): Promise<ArrayBuffer> {
    return this.sendRequest<ArrayBuffer>({ type: "generateAudio", text, voiceId });
  }

  /**
   * Terminate the worker.
   */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    // Reject all pending requests
    for (const [id, request] of this.pendingRequests) {
      request.reject(new Error("Worker terminated"));
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Check if the worker is available.
   */
  isAvailable(): boolean {
    return this.worker !== null && this.initError === null;
  }
}

/**
 * Singleton instance of the Piper worker client.
 */
let workerClientInstance: PiperWorkerClient | null = null;

/**
 * Get the singleton Piper worker client instance.
 *
 * Creates a new instance if one doesn't exist.
 */
export function getPiperWorkerClient(): PiperWorkerClient {
  if (!workerClientInstance) {
    workerClientInstance = new PiperWorkerClient();
  }
  return workerClientInstance;
}

/**
 * Check if Web Workers are supported in the current environment.
 */
export function isWebWorkerSupported(): boolean {
  return typeof Worker !== "undefined";
}
