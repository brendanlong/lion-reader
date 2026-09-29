/**
 * The element a voice preview plays through. It starts (on silence) when
 * created, so create it inside the tap: iOS only lets a gesture start
 * playback, and the clip arrives after an async synthesis.
 *
 * @module narration/preview-audio
 */

import { createSilentAudioDataUri } from "./silent-audio";

export class PreviewAudio {
  private readonly audio = new Audio(createSilentAudioDataUri());
  private url: string | null = null;

  constructor() {
    this.audio.loop = true;
    this.audio.play().catch(() => {});
  }

  /** Swaps in the clip; `onEnd` runs when it finishes or fails to play. */
  play(clip: Blob, rate: number, onEnd: () => void): void {
    this.url = URL.createObjectURL(clip);
    this.audio.loop = false;
    this.audio.src = this.url;
    this.audio.playbackRate = rate;
    this.audio.onended = onEnd;
    this.audio.play().catch(onEnd);
  }

  stop(): void {
    this.audio.onended = null;
    this.audio.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}
