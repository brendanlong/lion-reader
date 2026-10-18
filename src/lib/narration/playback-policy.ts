/**
 * MediaSourcePlayer's pure policy: what a failed synthesis becomes, what
 * playback does about it, and how far ahead to synthesize.
 */

import type { PlaybackStatus } from "./media-source-player";
import type { SpeechChunk } from "./speech-chunks";

/**
 * Times a chunk whose audio stopped arriving partway is synthesized again
 * before narration gives up on it.
 */
export const MAX_STREAM_RETRIES = 2;

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

/** A synthesis dropped because playback moved away from its chunk. */
export class SkippedSynthesis extends Error {
  constructor() {
    super("Synthesis skipped");
  }
}

/** A chunk whose stream dropped and is to be synthesized again. */
export class RetriedSynthesis extends Error {
  constructor() {
    super("Synthesis interrupted");
  }
}

/** A chunk that failed for now, to be synthesized again in `delayMs`. */
export class RetryLater extends Error {
  constructor(readonly delayMs: number) {
    super("Synthesis failed; trying again shortly");
  }
}

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

export function chunkFailureKind(failure: Error): ChunkFailureKind {
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
