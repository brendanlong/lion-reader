/**
 * Playback for synthesized narration through one Media Source Extensions
 * stream on one `<audio>` element.
 *
 * Mobile browsers only keep a backgrounded page (and its OS media controls)
 * alive while it is playing media; Web Speech and Web Audio are suspended
 * there, so synthesized speech must play through an element. Swapping an element's `src` per chunk
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

/** AAC-LC in MP4: what every MSE implementation plays, and what the server sends. */
export const AAC_MIME_TYPE = 'audio/mp4; codecs="mp4a.40.2"';

interface ManagedMediaSourceGlobal {
  ManagedMediaSource?: typeof MediaSource;
}

/**
 * The MSE implementation to use: iPhone Safari only has `ManagedMediaSource`
 * (17.1+); everything else has `MediaSource`. Null when neither exists.
 */
export function getMediaSourceClass(): typeof MediaSource | null {
  if (typeof window === "undefined") return null;
  return (
    (window as ManagedMediaSourceGlobal).ManagedMediaSource ??
    (typeof MediaSource === "undefined" ? null : MediaSource)
  );
}

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
export const MAX_STREAM_RETRIES = 2;
/**
 * The waits before trying a chunk again after a transient failure. Each try
 * may be paid for (and is rate-limited), so a few, spaced out; a failure the
 * synthesis already retried itself isn't retried here (see
 * `TransientSynthesisError.retryable`), so the layers don't multiply.
 */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
/**
 * Must outlast the slowest synthesis that still succeeds — the server waits up
 * to 15 s for a busy provider before streaming starts — because with the screen
 * locked, nothing recovers playback that stalls on an empty buffer. No more than
 * that: cloud voices are paid per character, and audio synthesized past where
 * the listener stops is wasted.
 */
const BUFFER_AHEAD_SECONDS = 30;

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
  /** Narration stopped. */
  onError?: (error: Error) => void;
  /** Narration paused where it ran out of audio it couldn't get ({@link TransientSynthesisError}). */
  onInterrupted?: (error: Error) => void;
  onEnd?: () => void;
}

export interface SpeechChunk {
  paragraph: number;
  text: string;
}

/**
 * Whether `text` has a letter or digit to say. Voices garble text that's only
 * symbols (a footnote's "↩", a "* * *" separator), so it isn't synthesized.
 */
function isSpeakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** One chunk per sentence, for synthesis that's slow enough to want the first audio fast. */
export function splitIntoSentenceChunks(paragraphs: string[]): SpeechChunk[] {
  return paragraphs.flatMap((paragraph, index) =>
    splitIntoSentences(paragraph.trim())
      .filter(isSpeakable)
      .map((text) => ({ paragraph: index, text }))
  );
}

/**
 * Splits paragraphs into synthesis chunks of at most `maxChars`, breaking long
 * paragraphs at sentence boundaries so playback can start (and skip) without
 * waiting for a whole long paragraph.
 */
export function splitIntoSpeechChunks(paragraphs: string[], maxChars: number): SpeechChunk[] {
  return paragraphs
    .flatMap((paragraph, index) => splitParagraph(paragraph, index, maxChars))
    .filter((chunk) => isSpeakable(chunk.text));
}

function splitParagraph(paragraph: string, index: number, maxChars: number): SpeechChunk[] {
  const text = paragraph.trim();
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
}

/**
 * A synthesis failure that may well pass (no connection, the server in
 * trouble). The chunk is tried again a few times, waiting longer each time;
 * if it still fails, playback pauses where it ran out, for play to try again.
 * Any other failure stops narration.
 */
export class TransientSynthesisError extends Error {
  constructor(
    message: string,
    /** False when the synthesis already asked again itself, enough: pause without more. */
    readonly retryable = true
  ) {
    super(message);
  }
}

/**
 * Thrown by a synthesis whose audio stopped arriving partway (a dropped
 * connection). The player throws away what that chunk had and synthesizes it
 * again, rather than playing a chunk with its end missing.
 */
export class StreamInterruptedError extends TransientSynthesisError {
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
  bufferAheadSeconds?: number;
  /** Duration at 1× of a chunk not synthesized yet. */
  estimateSeconds?: (text: string) => number;
  /** The waits before each new try of a chunk after a {@link TransientSynthesisError}. */
  retryDelaysMs?: number[];
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

/** A chunk that failed for now, to be synthesized again in `delayMs`. */
class RetryLater extends Error {
  constructor(readonly delayMs: number) {
    super("Synthesis failed; trying again shortly");
  }
}

/** One chunk's MP4 bytes, in order, as its synthesis produces them. */
class ChunkAudio {
  private readonly pieces: Uint8Array[] = [];
  private done = false;
  private failure: Error | null = null;
  private readonly controller = new AbortController();
  private waiters: (() => void)[] = [];
  /** Failed with {@link RetryLater}, and that time has come. */
  retryDue = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get finished(): boolean {
    return this.done || this.failure !== null;
  }

  get failed(): boolean {
    return this.failure !== null;
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

// ============================================================================
// Policy: what to do on a failure, how far to synthesize ahead, where skips land
// ============================================================================

/**
 * What a chunk's failed synthesis becomes, given how often it has failed
 * that way since it last finished.
 */
export type SynthesisFailureDecision =
  /** Playback moved away (or the chunk was dropped); asked for again if it gets near. */
  | { type: "skip" }
  /** Its stream dropped partway: synthesize it again now. */
  | { type: "resynthesize"; streamRetries: number }
  /** A transient failure: try again after `delayMs`. */
  | { type: "retry-later"; delayMs: number; transientFailures: number }
  /** Tried enough, or not worth trying again: `error` is the chunk's failure. */
  | { type: "give-up"; error: Error };

export function decideSynthesisFailure(
  error: unknown,
  context: {
    aborted: boolean;
    streamRetries: number;
    transientFailures: number;
    retryDelaysMs: readonly number[];
  }
): SynthesisFailureDecision {
  if (context.aborted || error instanceof SkippedSynthesis) return { type: "skip" };
  if (error instanceof StreamInterruptedError) {
    const streamRetries = context.streamRetries + 1;
    // A stream that keeps dropping has been asked for enough.
    if (streamRetries > MAX_STREAM_RETRIES) return { type: "give-up", error };
    return { type: "resynthesize", streamRetries };
  }
  if (
    error instanceof TransientSynthesisError &&
    error.retryable &&
    context.transientFailures < context.retryDelaysMs.length
  ) {
    return {
      type: "retry-later",
      delayMs: context.retryDelaysMs[context.transientFailures],
      transientFailures: context.transientFailures + 1,
    };
  }
  return { type: "give-up", error: error instanceof Error ? error : new Error(String(error)) };
}

/** What the append loop does when the chunk it waits on failed. */
export type AppendFailureDecision =
  /** Drop what of the chunk is buffered and play it again from its start; stop this loop. */
  | "replay"
  /** Ask for the chunk again and keep going. */
  | "retry"
  /** Stop this loop; it's woken again when the chunk is due or playback nears it. */
  | "wait"
  /** Pause once the playhead reaches the chunk (see `pauseIfBlocked`). */
  | "block"
  /** Stop narration. */
  | "fail";

/** A failed chunk's audio, by what {@link decideSynthesisFailure} decided. */
export type ChunkFailureKind =
  | "skipped"
  | "resynthesize"
  | "retry-later"
  /** Gave up on a transient failure: worth trying again when play is pressed. */
  | "transient"
  | "fatal";

function chunkFailureKind(failure: Error): ChunkFailureKind {
  if (failure instanceof SkippedSynthesis) return "skipped";
  if (failure instanceof RetriedSynthesis) return "resynthesize";
  if (failure instanceof RetryLater) return "retry-later";
  if (failure instanceof TransientSynthesisError) return "transient";
  return "fatal";
}

/**
 * @param context.placed - Some of the chunk is already buffered; part of a
 *   chunk is never played, so it's played again whole
 * @param context.superseded - The chunk was asked for again meanwhile
 */
export function decideAppendFailure(
  kind: ChunkFailureKind,
  context: { placed: boolean; superseded: boolean }
): AppendFailureDecision {
  switch (kind) {
    case "resynthesize":
      return context.placed ? "replay" : "retry";
    case "retry-later":
      if (context.superseded) return "retry";
      return context.placed ? "replay" : "wait";
    case "transient":
      if (context.superseded) return "retry";
      return context.placed ? "replay" : "block";
    case "skipped":
      return "wait";
    case "fatal":
      return "fail";
  }
}

/**
 * Whether playback should pause where a chunk keeps failing: only once it has
 * played everything buffered before it, and only for the run that hit it.
 */
export function shouldPauseForBlock(context: {
  blockedRun: number | null;
  run: number;
  status: PlaybackStatus;
  playheadBuffered: boolean;
}): boolean {
  return (
    context.blockedRun === context.run &&
    context.status === "buffering" &&
    !context.playheadBuffered
  );
}

/** A chunk's span on the element's timeline. */
export interface ChunkSpan {
  chunk: number;
  start: number;
  end: number;
  complete: boolean;
}

/**
 * The furthest chunk worth having synthesized: enough to cover
 * `bufferAheadSeconds` of playback (at `rate`) past the playhead, and always
 * at least the next chunk. Buffered chunks count what's left of them; the
 * rest are estimated from their text.
 *
 * @param placed - The current run's chunks, consecutive and in order
 */
export function lastWantedChunk(context: {
  index: number;
  chunks: readonly SpeechChunk[];
  placed: readonly ChunkSpan[];
  time: number;
  rate: number;
  bufferAheadSeconds: number;
  estimateSeconds: (text: string) => number;
}): number {
  const { index, chunks, placed, time, estimateSeconds } = context;
  const firstPlaced = placed[0]?.chunk ?? Infinity;
  let seconds = 0;
  let chunk = index;
  for (; chunk < chunks.length - 1; chunk++) {
    const span = placed[chunk - firstPlaced];
    if (span) {
      // A chunk still arriving is at least as long as what's arrived.
      const end = span.complete
        ? span.end
        : Math.max(span.end, span.start + estimateSeconds(chunks[chunk].text));
      seconds += Math.max(0, end - Math.max(span.start, time));
    } else {
      seconds += estimateSeconds(chunks[chunk].text);
    }
    if (seconds / context.rate >= context.bufferAheadSeconds) break;
  }
  return Math.min(Math.max(chunk, index + 1), chunks.length - 1);
}

/**
 * Whether a queued synthesis should start now, or be skipped: it must be for
 * the current text (`epoch`), not already done, and between the playing
 * chunk and the last one wanted.
 */
export function shouldStartSynthesis(context: {
  chunk: number;
  epoch: number;
  cacheEpoch: number;
  finished: boolean;
  status: PlaybackStatus;
  index: number;
  lastWanted: number;
}): boolean {
  return (
    context.epoch === context.cacheEpoch &&
    !context.finished &&
    context.status !== "idle" &&
    context.chunk >= context.index &&
    context.chunk <= context.lastWanted
  );
}

/** The first chunk of the paragraph after `index`'s; null on the last. */
export function nextParagraphChunk(chunks: readonly SpeechChunk[], index: number): number | null {
  const current = chunks[index]?.paragraph ?? 0;
  const next = chunks.findIndex((chunk) => chunk.paragraph > current);
  return next === -1 ? null : next;
}

/** The first chunk of the paragraph before `index`'s; null on the first. */
export function previousParagraphChunk(
  chunks: readonly SpeechChunk[],
  index: number
): number | null {
  const current = chunks[index]?.paragraph ?? 0;
  const previous = chunks.findLast((chunk) => chunk.paragraph < current)?.paragraph;
  if (previous === undefined) return null;
  return chunks.findIndex((chunk) => chunk.paragraph === previous);
}

/** The first chunk of `paragraph`, or of the next one with something to say; null past the end. */
export function paragraphChunk(chunks: readonly SpeechChunk[], paragraph: number): number | null {
  const index = chunks.findIndex((chunk) => chunk.paragraph >= paragraph);
  return index === -1 ? null : index;
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
  private readonly retryDelaysMs: number[];
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
  /** Transient failures per chunk since it last finished. */
  private transientFailures = new Map<number, number>();
  /**
   * The current run can't go on past a chunk that keeps failing transiently:
   * playback pauses once it has played what's buffered.
   */
  private blocked: { run: number; error: Error } | null = null;
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
    this.bufferAheadSeconds = options.bufferAheadSeconds ?? BUFFER_AHEAD_SECONDS;
    this.estimateSeconds =
      options.estimateSeconds ?? ((text) => text.length / ESTIMATED_CHARS_PER_SECOND);
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
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
      this.pauseIfBlocked();
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
    // It may have paused where synthesis ran out (pauseIfBlocked), or been
    // paused, or moved, while failures piled up: every failed chunk is asked
    // for afresh.
    this.forgetFailures();
    if (this.status === "paused" && !this.jumpPending) {
      this.setStatus(this.isPlayheadBuffered() ? "playing" : "buffering");
      void this.pump();
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

  /** The next paragraph; nothing on the last (the controls offer none there). */
  async skipForward(): Promise<void> {
    const next = nextParagraphChunk(this.chunks, this.index);
    if (next !== null) this.moveTo(next);
  }

  /** The previous paragraph; nothing on the first. */
  async skipBackward(): Promise<void> {
    const previous = previousParagraphChunk(this.chunks, this.index);
    if (previous !== null) this.moveTo(previous);
  }

  async skipTo(paragraph: number): Promise<void> {
    const index = paragraphChunk(this.chunks, paragraph);
    if (index !== null) this.moveTo(index);
  }

  stop(): void {
    for (const queued of this.queuedSyntheses.splice(0)) queued.skip();
    this.abortSyntheses(() => true);
    this.forgetFailures();
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
    this.transientFailures.clear();
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
          const failure = error instanceof Error ? error : new Error(String(error));
          const decision = decideAppendFailure(chunkFailureKind(failure), {
            placed: placed !== null,
            // Retried meanwhile (it was due, or play is trying again).
            superseded: this.chunkAudio.get(chunk) !== audio,
          });
          switch (decision) {
            case "replay":
              this.replayChunk(placed!);
              return;
            case "retry":
              continue;
            case "wait":
              return;
            case "block":
              this.blocked = { run, error: failure };
              this.pauseIfBlocked();
              return;
            case "fail":
              this.fail(failure);
              return;
          }
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

  /**
   * The chunk's audio, starting its synthesis unless it's under way, done, or
   * failed (and not due to be tried again).
   */
  private audioFor(chunk: number): ChunkAudio {
    const cached = this.chunkAudio.get(chunk);
    if (cached && !cached.retryDue) return cached;
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
          this.transientFailures.delete(chunk);
          audio.end();
        },
        (error: unknown) => {
          const failure = this.synthesisFailure(chunk, audio, error);
          // Skipped or dropped chunks are requested again (unless the entry
          // has since been replaced, e.g. after clearCache). Failed ones stay,
          // so look-ahead doesn't ask again on every time update.
          const asked = failure instanceof SkippedSynthesis || failure instanceof RetriedSynthesis;
          if (asked && this.chunkAudio.get(chunk) === audio) this.chunkAudio.delete(chunk);
          audio.fail(failure);
          if (failure instanceof RetryLater) {
            setTimeout(() => {
              audio.retryDue = true;
              this.prefetch();
              void this.pump();
            }, failure.delayMs);
          }
        }
      );
    return audio;
  }

  private synthesisFailure(chunk: number, audio: ChunkAudio, error: unknown): Error {
    const decision = decideSynthesisFailure(error, {
      aborted: audio.signal.aborted,
      streamRetries: this.streamRetries.get(chunk) ?? 0,
      transientFailures: this.transientFailures.get(chunk) ?? 0,
      retryDelaysMs: this.retryDelaysMs,
    });
    switch (decision.type) {
      case "skip":
        return new SkippedSynthesis();
      case "resynthesize":
        this.streamRetries.set(chunk, decision.streamRetries);
        return new RetriedSynthesis();
      case "retry-later":
        this.transientFailures.set(chunk, decision.transientFailures);
        return new RetryLater(decision.delayMs);
      case "give-up":
        return decision.error;
    }
  }

  /**
   * Pauses where the run can't go on ({@link blocked}), once the playhead has
   * caught up with it, so what's buffered still plays. Playing again tries
   * the chunks afresh.
   */
  private pauseIfBlocked(): void {
    const blocked = this.blocked;
    const pause = shouldPauseForBlock({
      blockedRun: blocked?.run ?? null,
      run: this.run,
      status: this.status,
      playheadBuffered: this.isPlayheadBuffered(),
    });
    if (!blocked || !pause) return;
    this.blocked = null;
    this.pause();
    this.callbacks.onInterrupted?.(blocked.error);
  }

  /**
   * Forgets every failed chunk and its retries, so they're asked for again.
   * Kept until then so look-ahead, which runs on every time update, doesn't
   * ask again and again.
   */
  private forgetFailures(): void {
    for (const [chunk, audio] of this.chunkAudio) {
      if (audio.failed) this.chunkAudio.delete(chunk);
    }
    this.streamRetries.clear();
    this.transientFailures.clear();
    this.blocked = null;
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
      const wanted = shouldStartSynthesis({
        chunk: next.chunk,
        epoch: next.epoch,
        cacheEpoch: this.cacheEpoch,
        finished: next.audio.finished,
        status: this.status,
        index: this.index,
        lastWanted: this.lastWantedChunk(),
      });
      if (wanted) next.start();
      else next.skip();
    }
  }

  private lastWantedChunk(): number {
    return lastWantedChunk({
      index: this.index,
      chunks: this.chunks,
      placed: this.placed,
      time: this.audio.currentTime,
      rate: this.rate,
      bufferAheadSeconds: this.bufferAheadSeconds,
      estimateSeconds: this.estimateSeconds,
    });
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
    // Up to the last paragraph with something to say, so the controls'
    // "is there a next one" agrees with skipForward, which moves by chunks.
    const spoken = (this.chunks.at(-1)?.paragraph ?? -1) + 1;
    this.callbacks.onPositionChange?.(position, Math.min(this.paragraphCount, spoken));
  }

  private setStatus(status: PlaybackStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.callbacks.onStatusChange?.(status);
  }
}
