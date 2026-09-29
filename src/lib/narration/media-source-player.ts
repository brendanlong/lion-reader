/**
 * Playback for synthesized narration through one Media Source Extensions
 * stream on one `<audio>` element.
 *
 * Mobile browsers only keep a backgrounded page (and its OS media controls)
 * alive while it is playing media. Swapping an element's `src` per chunk
 * hands the browser a fresh, often short, clip each time with a gap our
 * script has to bridge, and Chrome on Android treats clips under ~5 seconds as
 * sound effects rather than playback; narration played that way stopped a
 * while after the screen locked. Here each chunk is encoded as a
 * self-contained fragmented MP4 (see `./audio-encoding`) and appended to a
 * single `SourceBuffer` in `sequence` mode, so the element sees one long,
 * never-ending track. No separate silent-audio element is needed — and there
 * must not be one: iOS pauses one media element when another starts.
 *
 * The buffer holds one *run*: consecutive chunks laid end to end from where
 * playback started. Skipping to a chunk already in the run seeks; anything
 * else clears the buffer and starts a new run at the current playhead, so the
 * element never has to be reloaded.
 *
 * @module narration/media-source-player
 */

import { splitIntoSentences } from "./sentence-splitter";
import {
  getMediaSourceClass,
  loadSegmentEncoder,
  type PcmAudio,
  type SegmentEncoder,
} from "./audio-encoding";

/**
 * Chunks synthesized ahead of the one playing: about 10 s of Piper sentences,
 * and enough to cover cloud latency, which varies from well under a second to
 * 10+ s.
 */
const PREFETCH_CHUNKS = 3;
/** Finished chunks kept behind the one playing, for instant skip-back. */
const KEEP_BEHIND_CHUNKS = 5;
/** Slack when comparing our segment times to the buffered ranges. */
const TIME_EPSILON = 0.01;

const UNSUPPORTED_MESSAGE = "This browser can't stream narration audio";

export type PlaybackStatus = "idle" | "playing" | "paused" | "buffering";

export interface PlaybackPosition {
  paragraph: number;
  /** Chunk index within the paragraph. */
  sentence: number;
}

export interface PlayerCallbacks {
  onStatusChange?: (status: PlaybackStatus) => void;
  onPositionChange?: (position: PlaybackPosition, totalParagraphs: number) => void;
  onError?: (error: Error) => void;
  onEnd?: () => void;
}

export interface SpeechChunk {
  paragraph: number;
  text: string;
}

/** One chunk per sentence, for synthesis that's slow enough to want the first audio fast. */
export function splitIntoSentenceChunks(paragraphs: string[]): SpeechChunk[] {
  return paragraphs.flatMap((paragraph, index) =>
    splitIntoSentences(paragraph.trim()).map((text) => ({ paragraph: index, text }))
  );
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

export interface MediaSourcePlayerOptions {
  synthesize: (text: string) => Promise<PcmAudio>;
  chunkParagraphs: (paragraphs: string[]) => SpeechChunk[];
  /** Syntheses allowed to run at once; the nearest chunk still needed always goes first. */
  maxConcurrentSyntheses: number;
  loadEncoder?: () => Promise<SegmentEncoder | null>;
  createAudio?: () => HTMLAudioElement;
  /** Returns null when the browser has no MSE. */
  createMediaSource?: () => MediaSource | null;
  /** Points the element at the source; returns a function that detaches it. */
  attach?: (audio: HTMLAudioElement, source: MediaSource) => () => void;
}

/** A queued synthesis dropped because playback moved away from its chunk. */
class SkippedSynthesis extends Error {
  constructor() {
    super("Synthesis skipped");
  }
}

/** A chunk's place on the element's timeline. */
interface PlacedSegment {
  chunk: number;
  start: number;
  end: number;
}

interface Stream {
  source: MediaSource;
  detach: () => void;
  opened: Promise<void>;
  buffer: SourceBuffer | null;
  /** SourceBuffer operations must never overlap. */
  queue: Promise<void>;
}

function defaultLoadEncoder(): Promise<SegmentEncoder | null> {
  const mediaSource = getMediaSourceClass();
  return mediaSource ? loadSegmentEncoder(mediaSource) : Promise.resolve(null);
}

function defaultCreateMediaSource(): MediaSource | null {
  const mediaSource = getMediaSourceClass();
  return mediaSource ? new mediaSource() : null;
}

function defaultAttach(audio: HTMLAudioElement, source: MediaSource): () => void {
  // ManagedMediaSource won't open on an element that could AirPlay without
  // an alternative non-MSE source.
  audio.disableRemotePlayback = true;
  const url = URL.createObjectURL(source);
  audio.src = url;
  return () => {
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  };
}

/** Runs one SourceBuffer mutation and waits for it to finish. */
function update(buffer: SourceBuffer, start: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      buffer.removeEventListener("updateend", onEnd);
      buffer.removeEventListener("error", onError);
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Failed to buffer narration audio"));
    };
    buffer.addEventListener("updateend", onEnd);
    buffer.addEventListener("error", onError);
    try {
      start();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function bufferedEnd(buffer: SourceBuffer): number {
  const ranges = buffer.buffered;
  return ranges.length ? ranges.end(ranges.length - 1) : 0;
}

function isBuffered(buffer: SourceBuffer, segment: PlacedSegment): boolean {
  const ranges = buffer.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (
      ranges.start(i) <= segment.start + TIME_EPSILON &&
      ranges.end(i) >= segment.end - TIME_EPSILON
    ) {
      return true;
    }
  }
  return false;
}

/** End of the buffered range that starts at (or spans) `start`. */
function rangeEndFrom(buffer: SourceBuffer, start: number): number {
  const ranges = buffer.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= start + TIME_EPSILON && ranges.end(i) > start) return ranges.end(i);
  }
  return start;
}

export class MediaSourcePlayer {
  private readonly audio: HTMLAudioElement;
  private readonly synthesize: (text: string) => Promise<PcmAudio>;
  private readonly chunkParagraphs: (paragraphs: string[]) => SpeechChunk[];
  private readonly maxConcurrentSyntheses: number;
  private readonly loadEncoder: () => Promise<SegmentEncoder | null>;
  private readonly createMediaSource: () => MediaSource | null;
  private readonly attach: (audio: HTMLAudioElement, source: MediaSource) => () => void;

  private chunks: SpeechChunk[] = [];
  private paragraphCount = 0;
  /** The chunk playing, or the one to start from. */
  private index = 0;
  private status: PlaybackStatus = "idle";
  private callbacks: PlayerCallbacks = {};
  private rate = 1;
  private encoder: Promise<SegmentEncoder | null> | null = null;
  /** In-flight or finished encoded segments per chunk index. */
  private segments = new Map<number, Promise<Uint8Array>>();
  /** Bumped by clearCache, so synthesis finishing afterwards isn't cached. */
  private cacheEpoch = 0;
  private runningSyntheses = 0;
  private queuedSyntheses: {
    chunk: number;
    epoch: number;
    start: () => void;
    skip: () => void;
  }[] = [];
  /** Bumped by every prime(); see releasePrime. */
  private primeLease = 0;
  /** Bumped by pause/stop, so a play() they interrupt isn't reported as a failure. */
  private playRequest = 0;
  private stream: Stream | null = null;
  /** Bumped whenever the buffered run is replaced, so stale appends are dropped. */
  private run = 0;
  /** Where the current run begins on the element's timeline. */
  private runStart = 0;
  /** The current run's chunks, in order. */
  private placed: PlacedSegment[] = [];
  /** Next chunk to append to the current run. */
  private nextAppend = 0;
  /** The run whose pump loop is going, if any. */
  private pumpingRun = -1;
  /** Moved while paused or idle; the next play() starts from `index`. */
  private jumpPending = false;

  constructor(options: MediaSourcePlayerOptions) {
    this.synthesize = options.synthesize;
    this.chunkParagraphs = options.chunkParagraphs;
    this.maxConcurrentSyntheses = options.maxConcurrentSyntheses;
    this.loadEncoder = options.loadEncoder ?? defaultLoadEncoder;
    this.createMediaSource = options.createMediaSource ?? defaultCreateMediaSource;
    this.attach = options.attach ?? defaultAttach;
    this.audio = (options.createAudio ?? (() => new Audio()))();
    this.audio.preload = "auto";

    this.audio.addEventListener("timeupdate", () => this.onTimeUpdate());
    this.audio.addEventListener("waiting", () => {
      if (this.status === "playing") this.setStatus("buffering");
    });
    this.audio.addEventListener("playing", () => {
      if (this.status === "buffering") this.setStatus("playing");
    });
    this.audio.addEventListener("ended", () => {
      if (this.isActive() && this.nextAppend >= this.chunks.length) this.finish();
    });
    // The OS can pause the element itself (a phone call, Siri, unplugged
    // headphones). Track it, or a later "play" from the lock screen would be
    // ignored because we still think we're playing. Our own pauses change
    // status first; reaching the end also fires "pause".
    this.audio.addEventListener("pause", () => {
      if (!this.audio.paused || this.audio.ended) return;
      if (this.isActive()) {
        this.playRequest++;
        this.setStatus("paused");
      }
    });
    this.audio.addEventListener("error", () => {
      if (this.stream && this.isActive()) this.fail(new Error("Failed to play narration audio"));
    });
  }

  setCallbacks(callbacks: PlayerCallbacks): void {
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
   * Starts the element. Call synchronously inside the user gesture that
   * starts narration, before any async work, so autoplay policy lets it play
   * once audio arrives.
   *
   * @returns This prime's lease, to hand to {@link releasePrime} if playback
   *   never starts.
   */
  prime(): number {
    if (this.openStream()) this.audio.play().catch(() => {});
    return ++this.primeLease;
  }

  /**
   * Stops a primed element whose playback never started (generation failed or
   * the request was abandoned) — unless a later prime has taken the element
   * over since, so an abandoned request can't stop newer playback.
   */
  releasePrime(lease: number): void {
    if (lease === this.primeLease) this.stop();
  }

  load(paragraphs: string[]): void {
    const chunks = this.chunkParagraphs(paragraphs);
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
    if (this.isActive()) return;
    if (!this.openStream()) {
      this.fail(new Error(UNSUPPORTED_MESSAGE));
      return;
    }
    const request = ++this.playRequest;
    if (this.status === "paused" && !this.jumpPending) {
      this.setStatus(this.isPlayheadBuffered() ? "playing" : "buffering");
    } else {
      this.startRun(this.index);
      if (!this.isActive()) return;
    }
    try {
      await this.audio.play();
    } catch (error) {
      if (request === this.playRequest) this.fail(error);
    }
  }

  pause(): void {
    if (!this.isActive()) return;
    this.playRequest++;
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
    this.moveTo(next);
  }

  async skipBackward(): Promise<void> {
    const current = this.chunks[this.index]?.paragraph ?? 0;
    const previous = this.chunks.findLast((chunk) => chunk.paragraph < current)?.paragraph;
    this.moveTo(
      previous === undefined ? 0 : this.chunks.findIndex((chunk) => chunk.paragraph === previous)
    );
  }

  async skipTo(paragraph: number): Promise<void> {
    const index = this.chunks.findIndex((chunk) => chunk.paragraph >= paragraph);
    if (index !== -1) this.moveTo(index);
  }

  stop(): void {
    for (const queued of this.queuedSyntheses.splice(0)) queued.skip();
    this.run++;
    this.playRequest++;
    this.audio.pause();
    this.stream?.detach();
    this.stream = null;
    this.placed = [];
    this.nextAppend = 0;
    this.index = 0;
    this.jumpPending = false;
    this.setStatus("idle");
  }

  clearCache(): void {
    this.segments.clear();
    this.cacheEpoch++;
  }

  private isActive(): boolean {
    return this.status === "playing" || this.status === "buffering";
  }

  /** Returns false when the browser has no MSE. */
  private openStream(): boolean {
    if (this.stream) return true;
    const source = this.createMediaSource();
    if (!source) return false;
    // The element errors instead when it refuses the source.
    const opened = new Promise<void>((resolve, reject) => {
      const onError = () => reject(new Error("Failed to open the narration audio stream"));
      this.audio.addEventListener("error", onError, { once: true });
      source.addEventListener(
        "sourceopen",
        () => {
          this.audio.removeEventListener("error", onError);
          resolve();
        },
        { once: true }
      );
    });
    opened.catch(() => {});
    const detach = this.attach(this.audio, source);
    // Attaching a new source resets playbackRate to the default.
    this.audio.defaultPlaybackRate = this.rate;
    this.audio.playbackRate = this.rate;
    this.stream = { source, detach, opened, buffer: null, queue: Promise.resolve() };
    return true;
  }

  private moveTo(index: number): void {
    if (!this.isActive()) {
      // Stay put; the next play() starts a new run here. Retire the current
      // run so its pump doesn't prefetch (paid) chunks around the new index.
      this.run++;
      this.index = index;
      this.jumpPending = true;
      this.emitPosition();
      return;
    }
    const segment = this.placed.find((placed) => placed.chunk === index);
    const buffer = this.stream?.buffer;
    if (segment && buffer && isBuffered(buffer, segment)) {
      this.index = index;
      this.emitPosition();
      this.audio.currentTime = segment.start;
      void this.pump();
      return;
    }
    this.startRun(index);
  }

  /** Replaces whatever is buffered with a run starting at `index`, at the playhead. */
  private startRun(index: number): void {
    this.jumpPending = false;
    if (index >= this.chunks.length) {
      this.finish();
      return;
    }
    this.index = index;
    this.emitPosition();
    this.setStatus("buffering");
    this.restartRun(index, [], null);
  }

  /**
   * Starts a new run that keeps the `keep` segments and continues with chunk
   * `index` at time `at` (the playhead when null), removing anything buffered
   * from there on.
   */
  private restartRun(index: number, keep: PlacedSegment[], at: number | null): void {
    const run = ++this.run;
    this.placed = keep;
    this.nextAppend = index;
    this.enqueue(async (buffer) => {
      if (run !== this.run) return;
      const end = bufferedEnd(buffer);
      const removeFrom = at ?? 0;
      if (end > removeFrom) await update(buffer, () => buffer.remove(removeFrom, end));
      const start = at ?? this.audio.currentTime;
      this.runStart = start;
      buffer.timestampOffset = start;
      // Seeking flushes audio the decoder already read from the removed
      // range, which would otherwise play on and swallow the new run's start.
      if (at === null) this.audio.currentTime = start;
    }).catch((error: unknown) => {
      if (run === this.run) this.fail(error);
    });
    void this.pump();
  }

  /**
   * Synthesizes, encodes and appends the current run's chunks in order, up to
   * {@link PREFETCH_CHUNKS} ahead of the one playing. One loop per run: a
   * loop still waiting on a slow chunk from an abandoned run must not hold up
   * the new one.
   */
  private async pump(): Promise<void> {
    const run = this.run;
    if (this.pumpingRun === run) return;
    this.pumpingRun = run;
    try {
      while (run === this.run && this.stream && this.status !== "idle" && !this.jumpPending) {
        const chunk = this.nextAppend;
        if (chunk >= this.chunks.length) {
          await this.enqueue(() => {
            if (run === this.run && this.stream?.source.readyState === "open") {
              this.stream.source.endOfStream();
            }
          });
          return;
        }
        if (chunk > this.index + PREFETCH_CHUNKS) return;
        const pending = this.segment(chunk);
        for (let ahead = chunk + 1; ahead <= this.index + PREFETCH_CHUNKS; ahead++) {
          if (ahead < this.chunks.length) this.segment(ahead).catch(() => {});
        }

        let bytes: Uint8Array;
        try {
          bytes = await pending;
        } catch (error) {
          // A skipped chunk is requested again once playback gets near it.
          if (run === this.run && !(error instanceof SkippedSynthesis)) this.fail(error);
          return;
        }

        await this.enqueue(async (buffer) => {
          if (run !== this.run) return;
          const start = this.placed.at(-1)?.end ?? this.runStart;
          await update(buffer, () => buffer.appendBuffer(bytes as BufferSource));
          if (run !== this.run) return;
          this.placed.push({ chunk, start, end: rangeEndFrom(buffer, start) });
          this.nextAppend = chunk + 1;
          if (chunk === this.index && this.status === "buffering") this.setStatus("playing");
        });
        // The stream went away mid-append.
        if (run === this.run && this.nextAppend === chunk) return;
      }
    } catch (error) {
      if (run === this.run) this.fail(error);
    } finally {
      if (this.pumpingRun === run) this.pumpingRun = -1;
    }
  }

  private enqueue(op: (buffer: SourceBuffer) => Promise<void> | void): Promise<void> {
    const stream = this.stream;
    if (!stream) return Promise.resolve();
    const next = stream.queue.then(async () => {
      if (this.stream !== stream) return;
      const buffer = await this.sourceBufferFor(stream);
      if (buffer && this.stream === stream) await op(buffer);
    });
    stream.queue = next.catch(() => {});
    return next;
  }

  private async sourceBufferFor(stream: Stream): Promise<SourceBuffer | null> {
    if (stream.buffer) return stream.buffer;
    const [encoder] = await Promise.all([this.getEncoder(), stream.opened]);
    if (!encoder || this.stream !== stream) return null;
    const buffer = stream.source.addSourceBuffer(encoder.mimeType);
    buffer.mode = "sequence";
    // ManagedMediaSource may evict buffered audio to save memory.
    buffer.addEventListener("bufferedchange", () => this.recoverEvictions());
    stream.buffer = buffer;
    return buffer;
  }

  private getEncoder(): Promise<SegmentEncoder | null> {
    this.encoder ??= this.loadEncoder().catch((error: unknown) => {
      this.encoder = null;
      throw error;
    });
    return this.encoder;
  }

  private segment(chunk: number): Promise<Uint8Array> {
    let promise = this.segments.get(chunk);
    if (!promise) {
      const epoch = this.cacheEpoch;
      const text = this.chunks[chunk].text;
      promise = this.getEncoder().then(async (encoder) => {
        if (!encoder) throw new Error(UNSUPPORTED_MESSAGE);
        const audio = await this.scheduleSynthesis(chunk, epoch, () => this.synthesize(text));
        const bytes = await encoder.encode(audio);
        if (epoch !== this.cacheEpoch) throw new Error("Narration changed during synthesis");
        return bytes;
      });
      // Let a failed chunk be retried on the next attempt (unless the entry
      // has since been replaced, e.g. after clearCache).
      const settled = promise;
      promise.catch(() => {
        if (this.segments.get(chunk) === settled) this.segments.delete(chunk);
      });
      this.segments.set(chunk, promise);
    }
    return promise;
  }

  private scheduleSynthesis(
    chunk: number,
    epoch: number,
    synthesize: () => Promise<PcmAudio>
  ): Promise<PcmAudio> {
    return new Promise((resolve, reject) => {
      this.queuedSyntheses.push({
        chunk,
        epoch,
        start: () => {
          this.runningSyntheses++;
          synthesize()
            .then(resolve, reject)
            .finally(() => {
              this.runningSyntheses--;
              this.startSyntheses();
            });
        },
        skip: () => reject(new SkippedSynthesis()),
      });
      this.startSyntheses();
    });
  }

  private startSyntheses(): void {
    this.queuedSyntheses.sort((a, b) => a.chunk - b.chunk);
    while (this.runningSyntheses < this.maxConcurrentSyntheses && this.queuedSyntheses.length) {
      const next = this.queuedSyntheses.shift()!;
      // Chunk numbers from before clearCache belong to different text.
      const wanted =
        next.epoch === this.cacheEpoch &&
        this.status !== "idle" &&
        next.chunk >= this.index &&
        next.chunk <= this.index + PREFETCH_CHUNKS;
      if (wanted) next.start();
      else next.skip();
    }
  }

  private onTimeUpdate(): void {
    const time = this.audio.currentTime;
    const segment = this.placed.find((placed) => time >= placed.start && time < placed.end);
    if (!segment || segment.chunk === this.index) return;
    this.index = segment.chunk;
    this.emitPosition();
    this.evictBehind();
    void this.pump();
  }

  private evictBehind(): void {
    const keepFrom = this.index - KEEP_BEHIND_CHUNKS;
    for (const chunk of this.segments.keys()) {
      if (chunk < keepFrom) this.segments.delete(chunk);
    }
    const firstKept = this.placed.findIndex((placed) => placed.chunk >= keepFrom);
    if (firstKept <= 0) return;
    const cut = this.placed[firstKept].start;
    this.placed = this.placed.slice(firstKept);
    this.enqueue((buffer) => update(buffer, () => buffer.remove(0, cut))).catch(() => {
      // Only memory is at stake; the browser evicts on its own if it must.
    });
  }

  /** Re-appends anything the browser evicted from the part still to play. */
  private recoverEvictions(): void {
    // Queued: eviction usually happens inside one of our own appends, while
    // the buffer is still updating.
    this.enqueue((buffer) => {
      const lost = this.placed.findIndex(
        (placed) => placed.chunk >= this.index && !isBuffered(buffer, placed)
      );
      if (lost === -1) return;
      const from = this.placed[lost];
      this.restartRun(from.chunk, this.placed.slice(0, lost), from.start);
    }).catch(() => {});
  }

  private isPlayheadBuffered(): boolean {
    const buffer = this.stream?.buffer;
    if (!buffer) return false;
    const time = this.audio.currentTime;
    const ranges = buffer.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= time + TIME_EPSILON && ranges.end(i) > time) return true;
    }
    return false;
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
