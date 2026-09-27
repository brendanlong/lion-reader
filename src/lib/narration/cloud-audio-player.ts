/**
 * Playback for cloud voices (server-synthesized speech).
 *
 * Unlike Piper, which plays through the Web Audio API, cloud audio plays
 * through one real `<audio>` element. Mobile browsers keep a playing media
 * element alive when the page is backgrounded or the screen locks (Web Audio
 * gets suspended), and the element is also what surfaces the OS media
 * controls, so no separate silent-audio element is needed — and there must not
 * be one: iOS pauses one media element when another starts.
 *
 * The element never stops between chunks: while the next chunk is still being
 * synthesized it loops a silent clip, so the OS never sees playback end and
 * the next source swap is allowed to play without a fresh user gesture.
 *
 * @module narration/cloud-audio-player
 */

import { splitIntoSentences } from "./sentence-splitter";
import { createSilentAudioDataUri } from "./silent-audio";
import type {
  PlaybackPosition,
  PlaybackStatus,
  StreamingPlayerCallbacks,
} from "./streaming-audio-player";

/** Chunks synthesized ahead of the one playing. Cloud latency varies from well under a second to 10+ s. */
const PREFETCH_CHUNKS = 3;
/** Finished chunks kept behind the one playing, for instant skip-back. */
const KEEP_BEHIND_CHUNKS = 5;

export interface SpeechChunk {
  paragraph: number;
  text: string;
}

/**
 * Splits paragraphs into synthesis chunks of at most `maxChars`, breaking long
 * paragraphs at sentence boundaries so playback can start (and skip) without
 * waiting for a whole long paragraph.
 */
export function splitIntoSpeechChunks(paragraphs: string[], maxChars: number): SpeechChunk[] {
  return paragraphs.flatMap((paragraph, index) => {
    const text = paragraph.trim();
    if (!text) return [];
    if (text.length <= maxChars) return [{ paragraph: index, text }];

    const chunks: SpeechChunk[] = [];
    let current = "";
    // Sentences are word-split at a much smaller size, but a run without
    // whitespace (a long URL, unspaced CJK text) can still exceed the limit.
    const pieces = splitIntoSentences(text).flatMap((sentence) => {
      const slices: string[] = [];
      for (let start = 0; start < sentence.length; start += maxChars) {
        slices.push(sentence.slice(start, start + maxChars));
      }
      return slices;
    });
    for (const sentence of pieces) {
      if (current && current.length + 1 + sentence.length > maxChars) {
        chunks.push({ paragraph: index, text: current });
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current) chunks.push({ paragraph: index, text: current });
    return chunks;
  });
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

export class CloudAudioPlayer {
  private readonly audio: HTMLAudioElement;
  private readonly silentSrc = createSilentAudioDataUri();
  private chunks: SpeechChunk[] = [];
  private paragraphCount = 0;
  private index = 0;
  private status: PlaybackStatus = "idle";
  private callbacks: StreamingPlayerCallbacks = {};
  private rate = 1;
  /** In-flight or finished synthesis per chunk index. */
  private pending = new Map<number, Promise<string>>();
  /** Object URLs of finished chunks, revoked on clearCache. */
  private ready = new Map<number, string>();
  /** Bumped whenever playback moves, so a stale await never starts playing. */
  private generation = 0;
  /** Bumped by clearCache, so synthesis finishing afterwards isn't cached. */
  private cacheEpoch = 0;

  constructor(
    private readonly synthesize: (text: string) => Promise<Blob>,
    private readonly maxChunkChars: number,
    createAudio: () => HTMLAudioElement = () => new Audio()
  ) {
    this.audio = createAudio();
    this.audio.preload = "auto";
    this.audio.addEventListener("ended", () => {
      if (this.status === "playing") void this.startChunk(this.index + 1);
    });
    // The OS can pause the element itself (a phone call, Siri, unplugged
    // headphones). Track it, or a later "play" from the lock screen would be
    // ignored because we still think we're playing. The event is async and
    // also fires for our own src swaps and at the end of each clip, so only
    // act if the element is still paused (a swap has already played again)
    // and not merely finished. Our own pauses change status first.
    this.audio.addEventListener("pause", () => {
      if (!this.audio.paused || this.audio.ended) return;
      if (this.status === "playing" || this.status === "buffering") {
        this.generation++;
        this.setStatus("paused");
      }
    });
    this.audio.addEventListener("error", () => {
      if (this.status === "playing" && !this.audio.loop) {
        this.fail(new Error("Failed to play narration audio"));
      }
    });
  }

  setCallbacks(callbacks: StreamingPlayerCallbacks): void {
    this.callbacks = callbacks;
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
  }

  getStatus(): PlaybackStatus {
    return this.status;
  }

  /**
   * Starts the element (on silence). Call synchronously inside the user
   * gesture that starts narration, before any async work, so autoplay policy
   * lets every later source swap play.
   */
  prime(): void {
    this.playSilence();
  }

  load(paragraphs: string[]): void {
    const chunks = splitIntoSpeechChunks(paragraphs, this.maxChunkChars);
    const changed =
      chunks.length !== this.chunks.length ||
      chunks.some((chunk, i) => chunk.text !== this.chunks[i].text);
    if (changed) this.clearCache();
    this.chunks = chunks;
    this.paragraphCount = paragraphs.length;
    this.index = 0;
    this.setStatus("idle");
  }

  async play(): Promise<void> {
    if (this.status === "paused" && !this.audio.loop && this.audio.src) {
      const generation = ++this.generation;
      this.setStatus("playing");
      await this.audio.play().catch((error: unknown) => {
        // A pause right after resuming rejects this play(); that's not a failure.
        if (generation === this.generation) this.fail(error);
      });
      return;
    }
    if (this.status === "playing" || this.status === "buffering") return;
    await this.startChunk(this.index);
  }

  pause(): void {
    if (this.status !== "playing" && this.status !== "buffering") return;
    // Invalidate a chunk still being awaited so it doesn't start on arrival.
    this.generation++;
    this.audio.pause();
    this.setStatus("paused");
  }

  async skipForward(): Promise<void> {
    const current = this.chunks[this.index]?.paragraph ?? 0;
    const next = this.chunks.findIndex((chunk) => chunk.paragraph > current);
    if (next === -1) {
      this.finish();
      return;
    }
    await this.moveTo(next);
  }

  async skipBackward(): Promise<void> {
    const current = this.chunks[this.index]?.paragraph ?? 0;
    const previous = this.chunks.findLast((chunk) => chunk.paragraph < current)?.paragraph;
    await this.moveTo(
      previous === undefined ? 0 : this.chunks.findIndex((chunk) => chunk.paragraph === previous)
    );
  }

  async skipTo(paragraph: number): Promise<void> {
    const index = this.chunks.findIndex((chunk) => chunk.paragraph >= paragraph);
    if (index !== -1) await this.moveTo(index);
  }

  stop(): void {
    this.generation++;
    this.audio.pause();
    this.audio.loop = false;
    this.audio.removeAttribute("src");
    this.index = 0;
    this.setStatus("idle");
  }

  clearCache(): void {
    for (const url of this.ready.values()) URL.revokeObjectURL(url);
    this.ready.clear();
    this.pending.clear();
    this.cacheEpoch++;
  }

  private async moveTo(index: number): Promise<void> {
    if (this.status === "paused" || this.status === "idle") {
      // Stay paused at the new spot; the next play() starts it.
      this.generation++;
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.index = index;
      this.emitPosition();
      return;
    }
    await this.startChunk(index);
  }

  private async startChunk(index: number): Promise<void> {
    const generation = ++this.generation;
    if (index >= this.chunks.length) {
      this.finish();
      return;
    }
    this.index = index;
    this.emitPosition();
    this.evictBefore(index - KEEP_BEHIND_CHUNKS);
    for (let ahead = index; ahead < index + 1 + PREFETCH_CHUNKS; ahead++) {
      if (ahead < this.chunks.length) this.urlFor(ahead).catch(() => {});
    }

    let url = this.ready.get(index);
    if (!url) {
      this.setStatus("buffering");
      this.playSilence();
      try {
        url = await this.urlFor(index);
      } catch (error) {
        if (generation === this.generation) this.fail(error);
        return;
      }
      if (generation !== this.generation) return;
    }

    this.audio.loop = false;
    this.audio.src = url;
    this.audio.defaultPlaybackRate = this.rate;
    this.audio.playbackRate = this.rate;
    this.setStatus("playing");
    try {
      await this.audio.play();
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    }
  }

  private urlFor(index: number): Promise<string> {
    let promise = this.pending.get(index);
    if (!promise) {
      const epoch = this.cacheEpoch;
      promise = this.synthesize(this.chunks[index].text).then((blob) => {
        if (epoch !== this.cacheEpoch) throw new Error("Narration changed during synthesis");
        const url = URL.createObjectURL(blob);
        this.ready.set(index, url);
        return url;
      });
      // Let a failed chunk be retried on the next attempt (unless the entry
      // has since been replaced, e.g. after clearCache).
      const settled = promise;
      promise.catch(() => {
        if (this.pending.get(index) === settled) this.pending.delete(index);
      });
      this.pending.set(index, promise);
    }
    return promise;
  }

  private evictBefore(index: number): void {
    for (const [chunk, url] of this.ready) {
      if (chunk < index) {
        URL.revokeObjectURL(url);
        this.ready.delete(chunk);
        this.pending.delete(chunk);
      }
    }
  }

  private playSilence(): void {
    if (this.audio.loop && this.audio.src === this.silentSrc && !this.audio.paused) return;
    this.audio.loop = true;
    this.audio.src = this.silentSrc;
    this.audio.play().catch(() => {
      // Autoplay blocked: the chunk's own play() reports the failure.
    });
  }

  private finish(): void {
    this.stop();
    this.callbacks.onEnd?.();
  }

  private fail(error: unknown): void {
    this.stop();
    this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  private emitPosition(): void {
    const chunk = this.chunks[this.index];
    if (!chunk) return;
    const firstOfParagraph = this.chunks.findIndex((c) => c.paragraph === chunk.paragraph);
    const position: PlaybackPosition = {
      paragraph: chunk.paragraph,
      sentence: this.index - firstOfParagraph,
    };
    this.callbacks.onPositionChange?.(position, this.paragraphCount);
  }

  private setStatus(status: PlaybackStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.callbacks.onStatusChange?.(status);
  }
}
