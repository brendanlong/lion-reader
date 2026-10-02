/**
 * Playback for synthesized narration through one Media Source Extensions
 * stream on one `<audio>` element.
 *
 * Mobile browsers only keep a backgrounded page (and its OS media controls)
 * alive while it is playing media. Swapping an element's `src` per chunk
 * hands the browser a fresh, often short, clip each time with a gap our
 * script has to bridge, and Chrome on Android treats clips under ~5 seconds as
 * sound effects rather than playback; narration played that way stopped a
 * while after the screen locked. Here each chunk's audio is a self-contained
 * fragmented MP4, appended to a single `SourceBuffer` in `sequence` mode, so
 * the element sees one long, never-ending track. No separate silent-audio
 * element is needed — and there must not be one: iOS pauses one media element
 * when another starts.
 *
 * A chunk's synthesis may deliver its MP4 in several pieces (cloud voices
 * stream it; see `./cloud-speech`), each appended as it arrives — MSE takes
 * a box split across appends — so a chunk is playable up to what has arrived
 * and its place on the timeline grows.
 *
 * The buffer holds one *run*: consecutive chunks laid end to end from where
 * playback started. Skipping to a chunk already in the run seeks; anything
 * else clears the buffer and starts a new run at the current playhead, so the
 * element never has to be reloaded.
 *
 * @module narration/media-source-player
 */

import { splitIntoSentences } from "./sentence-splitter";
import { mp4PrimingSeconds } from "./mp4-priming";
import { getMediaSourceClass } from "./audio-encoding";

/** Rough speaking speed at 1×, for sizing chunks that aren't synthesized yet. */
const ESTIMATED_CHARS_PER_SECOND = 15;
/** Finished chunks kept behind the one playing, for instant skip-back. */
const KEEP_BEHIND_CHUNKS = 5;
/** Slack when comparing our segment times to the buffered ranges. */
const TIME_EPSILON = 0.01;
/**
 * Times a chunk whose audio stopped arriving partway is synthesized again
 * before narration gives up on it.
 */
const MAX_STREAM_RETRIES = 2;

/** For browsers without Media Source Extensions, or the audio format a voice needs. */
export const UNSUPPORTED_MESSAGE = "This browser can't stream narration audio";

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

/**
 * Thrown by a synthesis whose audio stopped arriving partway (a dropped
 * connection). The player throws away what that chunk had and synthesizes it
 * again, rather than playing a chunk with its end missing.
 */
export class StreamInterruptedError extends Error {
  constructor() {
    super("Lost the connection while narrating");
  }
}

export interface MediaSourcePlayerOptions {
  /**
   * Speaks one chunk as a complete fragmented MP4 of type {@link loadMimeType},
   * delivered as consecutive pieces of its bytes; each is played as soon as it
   * arrives. Stop when `signal` aborts.
   */
  synthesize: (text: string, signal: AbortSignal) => AsyncIterable<Uint8Array>;
  /**
   * The MIME type (with codec) of what `synthesize` produces. Rejects, with a
   * message for the listener, when this browser can't play it; nothing is
   * synthesized then.
   */
  loadMimeType: () => Promise<string>;
  chunkParagraphs: (paragraphs: string[]) => SpeechChunk[];
  /** Syntheses allowed to run at once; the nearest chunk still needed always goes first. */
  maxConcurrentSyntheses: number;
  /**
   * Seconds of playback (at the current rate) to keep synthesized past the
   * playhead. Measured for buffered chunks, estimated from text length for the
   * rest, so a run of short chunks doesn't leave the buffer thin.
   */
  bufferAheadSeconds: number;
  /** Duration at 1× of a chunk not synthesized yet. */
  estimateSeconds?: (text: string) => number;
  createAudio?: () => HTMLAudioElement;
  /** Returns null when the browser has no MSE. */
  createMediaSource?: () => MediaSource | null;
  /** Points the element at the source; returns a function that detaches it. */
  attach?: (audio: HTMLAudioElement, source: MediaSource) => () => void;
}

/** A synthesis dropped because playback moved away from its chunk. */
class SkippedSynthesis extends Error {
  constructor() {
    super("Synthesis skipped");
  }
}

/** A chunk whose stream dropped and is to be synthesized again. */
class RetriedSynthesis extends Error {
  constructor() {
    super("Synthesis interrupted");
  }
}

/** One chunk's MP4 bytes, in order, as its synthesis produces them. */
class ChunkAudio {
  private readonly pieces: Uint8Array[] = [];
  private done = false;
  private failure: Error | null = null;
  private readonly controller = new AbortController();
  private waiters: (() => void)[] = [];

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get finished(): boolean {
    return this.done || this.failure !== null;
  }

  /**
   * Waits for pieces past the first `from`, and returns all that have arrived;
   * null once the chunk ended without more.
   */
  async piecesFrom(from: number): Promise<Uint8Array[] | null> {
    for (;;) {
      if (this.failure) throw this.failure;
      if (from < this.pieces.length) return this.pieces.slice(from);
      if (this.done) return null;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  add(piece: Uint8Array): void {
    if (this.finished) return;
    this.pieces.push(piece);
    this.wake();
  }

  end(): void {
    if (this.finished) return;
    this.done = true;
    this.wake();
  }

  fail(error: Error): void {
    if (this.finished) return;
    this.failure = error;
    this.wake();
  }

  /** Stops synthesis; anyone waiting sees a skip. */
  abort(): void {
    this.fail(new SkippedSynthesis());
    this.controller.abort();
  }

  private wake(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }
}

/** A chunk's place on the element's timeline. */
interface PlacedChunk {
  chunk: number;
  start: number;
  /** Grows as pieces are appended, until `complete`. */
  end: number;
  /** The audio the appended pieces came from. */
  audio: ChunkAudio;
  /** Pieces of `audio` appended so far. */
  appended: number;
  complete: boolean;
}

interface Stream {
  source: MediaSource;
  detach: () => void;
  opened: Promise<void>;
  buffer: SourceBuffer | null;
  /** SourceBuffer operations must never overlap. */
  queue: Promise<void>;
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

function concat(pieces: Uint8Array[]): Uint8Array {
  if (pieces.length === 1) return pieces[0];
  const bytes = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.length;
  }
  return bytes;
}

function bufferedEnd(buffer: SourceBuffer): number {
  const ranges = buffer.buffered;
  return ranges.length ? ranges.end(ranges.length - 1) : 0;
}

function isBuffered(buffer: SourceBuffer, placed: PlacedChunk): boolean {
  const ranges = buffer.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (
      ranges.start(i) <= placed.start + TIME_EPSILON &&
      ranges.end(i) >= placed.end - TIME_EPSILON
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
  private readonly synthesize: (text: string, signal: AbortSignal) => AsyncIterable<Uint8Array>;
  private readonly loadMimeType: () => Promise<string>;
  private readonly chunkParagraphs: (paragraphs: string[]) => SpeechChunk[];
  private readonly maxConcurrentSyntheses: number;
  private readonly bufferAheadSeconds: number;
  private readonly estimateSeconds: (text: string) => number;
  private readonly createMediaSource: () => MediaSource | null;
  private readonly attach: (audio: HTMLAudioElement, source: MediaSource) => () => void;

  private chunks: SpeechChunk[] = [];
  private paragraphCount = 0;
  /** The chunk playing, or the one to start from. */
  private index = 0;
  private status: PlaybackStatus = "idle";
  private callbacks: PlayerCallbacks = {};
  private rate = 1;
  private mimeType: Promise<string> | null = null;
  /** Synthesizing or synthesized audio per chunk index. */
  private chunkAudio = new Map<number, ChunkAudio>();
  /** Streams that dropped partway, per chunk, since it last finished. */
  private streamRetries = new Map<number, number>();
  /** Bumped by clearCache, so synthesis queued before it doesn't start. */
  private cacheEpoch = 0;
  private runningSyntheses = 0;
  private queuedSyntheses: {
    chunk: number;
    epoch: number;
    audio: ChunkAudio;
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
  /**
   * Where to seek once the current run's first audio is buffered. Not
   * before: Chromium ignores a seek into a range just removed (seen when
   * replaying a chunk), apparently because only buffered time is seekable
   * while the stream's length is open-ended.
   */
  private seekOnAppend: number | null = null;
  /** The current run's chunks, in order. */
  private placed: PlacedChunk[] = [];
  /** Next chunk to finish appending to the current run. */
  private nextAppend = 0;
  /** The run whose pump loop is going, if any. */
  private pumpingRun = -1;
  /** Moved while paused or idle; the next play() starts from `index`. */
  private jumpPending = false;

  constructor(options: MediaSourcePlayerOptions) {
    this.synthesize = options.synthesize;
    this.chunkParagraphs = options.chunkParagraphs;
    this.maxConcurrentSyntheses = options.maxConcurrentSyntheses;
    this.bufferAheadSeconds = options.bufferAheadSeconds;
    this.estimateSeconds =
      options.estimateSeconds ?? ((text) => text.length / ESTIMATED_CHARS_PER_SECOND);
    this.loadMimeType = options.loadMimeType;
    this.createMediaSource = options.createMediaSource ?? defaultCreateMediaSource;
    this.attach = options.attach ?? defaultAttach;
    this.audio = (options.createAudio ?? (() => new Audio()))();
    this.audio.preload = "auto";

    this.audio.addEventListener("timeupdate", () => this.onTimeUpdate());
    // Also how catching up with a chunk that's still arriving shows: the
    // element waits for more, then plays on.
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
    this.abortSyntheses(() => true);
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
    for (const audio of this.chunkAudio.values()) audio.abort();
    this.chunkAudio.clear();
    this.streamRetries.clear();
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
    // Chunks left behind are only worth finishing if they're nearly done,
    // and there's no telling; a paid stream for audio nobody hears is waste.
    this.abortSyntheses((chunk) => chunk < index);
    if (!this.isActive()) {
      // Stay put; the next play() starts a new run here. Retire the current
      // run so its pump doesn't prefetch (paid) chunks around the new index.
      this.run++;
      this.index = index;
      this.jumpPending = true;
      this.emitPosition();
      return;
    }
    const placed = this.placed.find((candidate) => candidate.chunk === index);
    const buffer = this.stream?.buffer;
    if (placed && buffer && isBuffered(buffer, placed)) {
      this.index = index;
      this.emitPosition();
      this.audio.currentTime = placed.start;
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
   * Starts a new run that keeps the `keep` chunks and continues with chunk
   * `index` at time `at` (the playhead when null), removing anything buffered
   * from there on. `seek` moves the playhead to `at` too, for when the audio
   * under it is being replaced.
   */
  private restartRun(index: number, keep: PlacedChunk[], at: number | null, seek = false): void {
    const run = ++this.run;
    this.placed = keep;
    this.nextAppend = index;
    this.enqueue(async (buffer) => {
      if (run !== this.run) return;
      // The run being replaced may have stopped partway through an MP4 box;
      // the next append is a new file. Once ended, nothing is left partway.
      if (this.stream?.source.readyState === "open") buffer.abort();
      const end = bufferedEnd(buffer);
      const removeFrom = at ?? 0;
      if (end > removeFrom) await update(buffer, () => buffer.remove(removeFrom, end));
      const start = at ?? this.audio.currentTime;
      this.runStart = start;
      buffer.timestampOffset = start;
      // Seeking flushes audio the decoder already read from the removed
      // range, which would otherwise play on and swallow the new run's start.
      this.seekOnAppend = at === null || seek ? start : null;
    }).catch((error: unknown) => {
      if (run === this.run) this.fail(error);
    });
    void this.pump();
  }

  /**
   * Plays a chunk from its start again with freshly synthesized audio, after
   * its stream dropped partway. Synthesis may not repeat itself sample for
   * sample, so resuming the new audio where the old one stopped could repeat
   * or skip words; replaying the chunk can't.
   */
  private replayChunk(placed: PlacedChunk): void {
    const at = this.placed.indexOf(placed);
    if (at === -1) return;
    const reached = this.audio.currentTime >= placed.start - TIME_EPSILON;
    if (reached) {
      this.index = placed.chunk;
      this.emitPosition();
      if (this.status === "playing") this.setStatus("buffering");
    }
    this.restartRun(placed.chunk, this.placed.slice(0, at), placed.start, reached);
  }

  /**
   * Synthesizes, encodes and appends the current run's chunks in order, up to
   * {@link lastWantedChunk}, each piece as soon as it arrives. One loop per
   * run: a loop still waiting on a slow chunk from an abandoned run must not
   * hold up the new one.
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
        const last = this.placed.at(-1);
        const placed = last?.chunk === chunk ? last : null;
        // A chunk that's started playing is always finished, whatever the lookahead.
        if (!placed && chunk > this.lastWantedChunk()) return;
        const audio = this.audioFor(chunk);
        this.prefetch();
        if (placed && placed.audio !== audio) {
          // Its stream dropped while this loop wasn't watching.
          this.replayChunk(placed);
          return;
        }

        let pieces: Uint8Array[] | null;
        try {
          pieces = await audio.piecesFrom(placed?.appended ?? 0);
        } catch (error) {
          if (run !== this.run) return;
          if (error instanceof RetriedSynthesis) {
            if (placed) {
              this.replayChunk(placed);
              return;
            }
            continue;
          }
          // A skipped chunk is requested again once playback gets near it.
          if (!(error instanceof SkippedSynthesis)) this.fail(error);
          return;
        }
        if (run !== this.run) return;

        if (pieces === null) {
          // Queued, so a chunk with no audio at all is placed after the run has started.
          await this.enqueue(() => {
            if (run !== this.run) return;
            if (placed) placed.complete = true;
            else {
              const start = this.placed.at(-1)?.end ?? this.runStart;
              this.placed.push({ chunk, start, end: start, audio, appended: 0, complete: true });
            }
            this.nextAppend = chunk + 1;
          });
          // The stream went away first.
          if (run === this.run && this.nextAppend === chunk) return;
          continue;
        }

        const appendedBefore = placed?.appended ?? 0;
        const arrived = pieces;
        const bytes = concat(arrived);
        await this.enqueue(async (buffer) => {
          if (run !== this.run) return;
          const start = placed?.start ?? this.placed.at(-1)?.end ?? this.runStart;
          if (!placed) {
            // Each chunk is its own encode, starting with the encoder's
            // priming. Its edit list says to skip that, but sequence mode
            // ignores edit lists, so the append window cuts it instead;
            // otherwise every join would pause for it.
            buffer.timestampOffset = start - mp4PrimingSeconds(bytes);
            buffer.appendWindowStart = start;
          }
          await update(buffer, () => buffer.appendBuffer(bytes as BufferSource));
          if (run !== this.run) return;
          const end = rangeEndFrom(buffer, start);
          if (placed) {
            placed.end = end;
            placed.appended += arrived.length;
          } else {
            this.placed.push({
              chunk,
              start,
              end,
              audio,
              appended: arrived.length,
              complete: false,
            });
          }
          if (this.seekOnAppend !== null && end > this.seekOnAppend) {
            this.audio.currentTime = this.seekOnAppend;
            this.seekOnAppend = null;
          }
          if (this.status === "buffering" && this.isPlayheadBuffered()) this.setStatus("playing");
        });
        // The stream went away mid-append.
        const now = this.placed.at(-1);
        if (run === this.run && (now?.chunk !== chunk || now.appended === appendedBefore)) return;
      }
    } catch (error) {
      if (run === this.run) this.fail(error);
    } finally {
      if (this.pumpingRun === run) this.pumpingRun = -1;
    }
  }

  /** Starts synthesizing the chunks from the one being appended on, as far as wanted. */
  private prefetch(): void {
    if (!this.stream || this.status === "idle" || this.jumpPending) return;
    const lastWanted = this.lastWantedChunk();
    for (let ahead = this.nextAppend; ahead <= lastWanted; ahead++) this.audioFor(ahead);
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
    const [mimeType] = await Promise.all([this.getMimeType(), stream.opened]);
    if (this.stream !== stream) return null;
    const buffer = stream.source.addSourceBuffer(mimeType);
    buffer.mode = "sequence";
    // ManagedMediaSource may evict buffered audio to save memory.
    buffer.addEventListener("bufferedchange", () => this.recoverEvictions());
    stream.buffer = buffer;
    return buffer;
  }

  private getMimeType(): Promise<string> {
    this.mimeType ??= this.loadMimeType().catch((error: unknown) => {
      this.mimeType = null;
      throw error;
    });
    return this.mimeType;
  }

  /** The chunk's audio, starting its synthesis unless it's already under way or done. */
  private audioFor(chunk: number): ChunkAudio {
    const cached = this.chunkAudio.get(chunk);
    if (cached) return cached;
    const audio = new ChunkAudio();
    this.chunkAudio.set(chunk, audio);
    const epoch = this.cacheEpoch;
    const text = this.chunks[chunk].text;
    this.getMimeType()
      .then(() =>
        this.scheduleSynthesis(chunk, epoch, audio, async () => {
          for await (const piece of this.synthesize(text, audio.signal)) {
            if (audio.finished) return;
            audio.add(piece);
          }
        })
      )
      .then(
        () => {
          this.streamRetries.delete(chunk);
          audio.end();
        },
        (error: unknown) => {
          // Let a failed chunk be requested again (unless the entry has
          // since been replaced, e.g. after clearCache).
          if (this.chunkAudio.get(chunk) === audio) this.chunkAudio.delete(chunk);
          audio.fail(this.synthesisFailure(chunk, audio, error));
        }
      );
    return audio;
  }

  private synthesisFailure(chunk: number, audio: ChunkAudio, error: unknown): Error {
    if (audio.signal.aborted || error instanceof SkippedSynthesis) return new SkippedSynthesis();
    if (error instanceof StreamInterruptedError) {
      const retries = (this.streamRetries.get(chunk) ?? 0) + 1;
      if (retries <= MAX_STREAM_RETRIES) {
        this.streamRetries.set(chunk, retries);
        return new RetriedSynthesis();
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /** Stops the unfinished syntheses of the chunks `drop` picks, and forgets them. */
  private abortSyntheses(drop: (chunk: number) => boolean): void {
    for (const [chunk, audio] of this.chunkAudio) {
      if (!audio.finished && drop(chunk)) {
        audio.abort();
        this.chunkAudio.delete(chunk);
      }
    }
  }

  private scheduleSynthesis(
    chunk: number,
    epoch: number,
    audio: ChunkAudio,
    synthesize: () => Promise<void>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queuedSyntheses.push({
        chunk,
        epoch,
        audio,
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
        !next.audio.finished &&
        this.status !== "idle" &&
        next.chunk >= this.index &&
        next.chunk <= this.lastWantedChunk();
      if (wanted) next.start();
      else next.skip();
    }
  }

  /**
   * The furthest chunk worth having synthesized: enough to cover
   * {@link MediaSourcePlayerOptions.bufferAheadSeconds} past the playhead,
   * and always at least the next chunk.
   */
  private lastWantedChunk(): number {
    const time = this.audio.currentTime;
    const firstPlaced = this.placed[0]?.chunk ?? Infinity;
    let seconds = 0;
    let chunk = this.index;
    for (; chunk < this.chunks.length - 1; chunk++) {
      // The run's placed chunks are consecutive, so index straight in.
      const placed = this.placed[chunk - firstPlaced];
      if (placed) {
        // A chunk still arriving is at least as long as what's arrived.
        const end = placed.complete
          ? placed.end
          : Math.max(placed.end, placed.start + this.estimateSeconds(this.chunks[chunk].text));
        seconds += Math.max(0, end - Math.max(placed.start, time));
      } else {
        seconds += this.estimateSeconds(this.chunks[chunk].text);
      }
      if (seconds / this.rate >= this.bufferAheadSeconds) break;
    }
    return Math.min(Math.max(chunk, this.index + 1), this.chunks.length - 1);
  }

  private onTimeUpdate(): void {
    const time = this.audio.currentTime;
    const placed = this.placed.find((candidate) => time >= candidate.start && time < candidate.end);
    if (placed && placed.chunk !== this.index) {
      this.index = placed.chunk;
      this.emitPosition();
      this.evictBehind();
    }
    // The playhead moving shrinks what's buffered ahead of it.
    this.prefetch();
    void this.pump();
  }

  private evictBehind(): void {
    const keepFrom = this.index - KEEP_BEHIND_CHUNKS;
    for (const [chunk, audio] of this.chunkAudio) {
      if (chunk < keepFrom) {
        audio.abort();
        this.chunkAudio.delete(chunk);
      }
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
