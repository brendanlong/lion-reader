/**
 * Table tests for MediaSourcePlayer's pure policy: what a failed chunk
 * becomes, what playback does about it, how far ahead to synthesize, and
 * where skips land. The player itself is tested against fakes in
 * media-source-player.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  decideAppendFailure,
  decideSynthesisFailure,
  lastWantedChunk,
  MAX_STREAM_RETRIES,
  nextParagraphChunk,
  paragraphChunk,
  previousParagraphChunk,
  shouldPauseForBlock,
  shouldStartSynthesis,
  StreamInterruptedError,
  TransientSynthesisError,
  type AppendFailureDecision,
  type ChunkFailureKind,
  type ChunkSpan,
  type SpeechChunk,
} from "@/lib/narration/media-source-player";

const DELAYS = [2_000, 5_000, 10_000];

describe("decideSynthesisFailure", () => {
  const fresh = { aborted: false, streamRetries: 0, transientFailures: 0, retryDelaysMs: DELAYS };

  it("skips a synthesis that was aborted, whatever it threw", () => {
    expect(
      decideSynthesisFailure(new StreamInterruptedError(), { ...fresh, aborted: true })
    ).toEqual({ type: "skip" });
    expect(decideSynthesisFailure(new Error("boom"), { ...fresh, aborted: true })).toEqual({
      type: "skip",
    });
  });

  it.each(Array.from({ length: MAX_STREAM_RETRIES }, (_, streamRetries) => ({ streamRetries })))(
    "synthesizes a dropped stream again ($streamRetries retries so far)",
    ({ streamRetries }) => {
      expect(
        decideSynthesisFailure(new StreamInterruptedError(), { ...fresh, streamRetries })
      ).toEqual({ type: "resynthesize", streamRetries: streamRetries + 1 });
    }
  );

  it("gives up on a stream that keeps dropping", () => {
    const error = new StreamInterruptedError();
    expect(decideSynthesisFailure(error, { ...fresh, streamRetries: MAX_STREAM_RETRIES })).toEqual({
      type: "give-up",
      error,
    });
  });

  it("doesn't spend transient retries on dropped streams", () => {
    expect(
      decideSynthesisFailure(new StreamInterruptedError(), { ...fresh, transientFailures: 3 })
    ).toEqual({ type: "resynthesize", streamRetries: 1 });
  });

  it.each([
    { transientFailures: 0, delayMs: 2_000 },
    { transientFailures: 1, delayMs: 5_000 },
    { transientFailures: 2, delayMs: 10_000 },
  ])(
    "retries a transient failure later, waiting longer each time ($transientFailures so far)",
    (row) => {
      expect(
        decideSynthesisFailure(new TransientSynthesisError("offline"), {
          ...fresh,
          transientFailures: row.transientFailures,
        })
      ).toEqual({
        type: "retry-later",
        delayMs: row.delayMs,
        transientFailures: row.transientFailures + 1,
      });
    }
  );

  it("gives up on a transient failure once the retries run out", () => {
    const error = new TransientSynthesisError("offline");
    expect(decideSynthesisFailure(error, { ...fresh, transientFailures: 3 })).toEqual({
      type: "give-up",
      error,
    });
  });

  it("doesn't retry a transient failure the synthesis already retried itself", () => {
    const error = new TransientSynthesisError("busy", false);
    expect(decideSynthesisFailure(error, fresh)).toEqual({ type: "give-up", error });
  });

  it("gives up on any other failure, as an Error", () => {
    const error = new Error("bad voice");
    expect(decideSynthesisFailure(error, fresh)).toEqual({ type: "give-up", error });
    const wrapped = decideSynthesisFailure("text", fresh);
    expect(wrapped.type === "give-up" && wrapped.error.message).toBe("text");
  });
});

describe("decideAppendFailure", () => {
  const rows: Array<{
    kind: ChunkFailureKind;
    placed: boolean;
    superseded: boolean;
    expected: AppendFailureDecision;
  }> = [
    { kind: "resynthesize", placed: false, superseded: false, expected: "retry" },
    { kind: "resynthesize", placed: false, superseded: true, expected: "retry" },
    { kind: "resynthesize", placed: true, superseded: false, expected: "replay" },
    { kind: "resynthesize", placed: true, superseded: true, expected: "replay" },
    { kind: "retry-later", placed: false, superseded: false, expected: "wait" },
    { kind: "retry-later", placed: true, superseded: false, expected: "replay" },
    { kind: "retry-later", placed: false, superseded: true, expected: "retry" },
    { kind: "retry-later", placed: true, superseded: true, expected: "retry" },
    { kind: "transient", placed: false, superseded: false, expected: "block" },
    { kind: "transient", placed: true, superseded: false, expected: "replay" },
    { kind: "transient", placed: false, superseded: true, expected: "retry" },
    { kind: "transient", placed: true, superseded: true, expected: "retry" },
    { kind: "skipped", placed: false, superseded: false, expected: "wait" },
    { kind: "skipped", placed: true, superseded: true, expected: "wait" },
    { kind: "fatal", placed: false, superseded: false, expected: "fail" },
    { kind: "fatal", placed: true, superseded: true, expected: "fail" },
  ];

  it.each(rows)(
    "$kind (placed: $placed, superseded: $superseded) → $expected",
    ({ kind, placed, superseded, expected }) => {
      expect(decideAppendFailure(kind, { placed, superseded })).toBe(expected);
    }
  );
});

describe("shouldPauseForBlock", () => {
  const blocked = { blockedRun: 3, run: 3, status: "buffering" as const, playheadBuffered: false };

  it("pauses once the blocked run has played what's buffered", () => {
    expect(shouldPauseForBlock(blocked)).toBe(true);
  });

  it.each([
    { name: "nothing is blocked", change: { blockedRun: null } },
    { name: "a replaced run was blocked", change: { run: 4 } },
    { name: "audio is still playing", change: { status: "playing" as const } },
    { name: "already paused", change: { status: "paused" as const } },
    { name: "the playhead still has audio", change: { playheadBuffered: true } },
  ])("doesn't pause when $name", ({ change }) => {
    expect(shouldPauseForBlock({ ...blocked, ...change })).toBe(false);
  });
});

/** Chunks of 15 characters: one second each at the default estimate. */
const textChunks = (paragraphs: number[]): SpeechChunk[] =>
  paragraphs.map((paragraph) => ({ paragraph, text: "x".repeat(15) }));

describe("lastWantedChunk", () => {
  const base = {
    index: 0,
    chunks: textChunks([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    placed: [] as ChunkSpan[],
    time: 0,
    rate: 1,
    bufferAheadSeconds: 3,
    estimateSeconds: (text: string) => text.length / 15,
  };

  it("covers the buffer-ahead window by estimate when nothing is synthesized", () => {
    expect(lastWantedChunk(base)).toBe(2);
  });

  it("always wants the next chunk", () => {
    expect(lastWantedChunk({ ...base, bufferAheadSeconds: 0 })).toBe(1);
  });

  it("stops at the last chunk", () => {
    expect(lastWantedChunk({ ...base, index: 8, bufferAheadSeconds: 100 })).toBe(9);
    expect(lastWantedChunk({ ...base, index: 9 })).toBe(9);
  });

  it("counts only what's left of buffered chunks past the playhead", () => {
    const placed: ChunkSpan[] = [
      { chunk: 0, start: 0, end: 4, complete: true },
      { chunk: 1, start: 4, end: 8, complete: true },
    ];
    // 0.5s left of chunk 0, then 4s of chunk 1.
    expect(lastWantedChunk({ ...base, placed, time: 3.5 })).toBe(1);
    // Chunk 0 alone covers the window from its start.
    expect(lastWantedChunk({ ...base, placed, time: 0 })).toBe(1);
  });

  it("counts a chunk still arriving as at least its estimate", () => {
    const placed: ChunkSpan[] = [{ chunk: 0, start: 0, end: 0.2, complete: false }];
    expect(lastWantedChunk({ ...base, placed })).toBe(2);
  });

  it("looks further ahead at a faster rate", () => {
    expect(lastWantedChunk({ ...base, rate: 2 })).toBe(5);
  });

  it("measures from the run's first placed chunk", () => {
    const placed: ChunkSpan[] = [{ chunk: 4, start: 10, end: 20, complete: true }];
    expect(lastWantedChunk({ ...base, index: 4, placed, time: 10 })).toBe(5);
  });
});

describe("shouldStartSynthesis", () => {
  const wanted = {
    chunk: 3,
    epoch: 1,
    cacheEpoch: 1,
    finished: false,
    status: "playing" as const,
    index: 2,
    lastWanted: 4,
  };

  it("starts a chunk between the playing one and the last wanted", () => {
    expect(shouldStartSynthesis(wanted)).toBe(true);
    expect(shouldStartSynthesis({ ...wanted, chunk: 2 })).toBe(true);
    expect(shouldStartSynthesis({ ...wanted, chunk: 4 })).toBe(true);
  });

  it.each([
    { name: "it was queued for text since replaced", change: { epoch: 0 } },
    { name: "its audio is already done", change: { finished: true } },
    { name: "playback stopped", change: { status: "idle" as const } },
    { name: "playback is past it", change: { chunk: 1 } },
    { name: "it's beyond the look-ahead", change: { chunk: 5 } },
  ])("skips it when $name", ({ change }) => {
    expect(shouldStartSynthesis({ ...wanted, ...change })).toBe(false);
  });

  it("still starts while paused or buffering", () => {
    expect(shouldStartSynthesis({ ...wanted, status: "paused" })).toBe(true);
    expect(shouldStartSynthesis({ ...wanted, status: "buffering" })).toBe(true);
  });
});

describe("skip targets", () => {
  // Paragraph 1 has three chunks; paragraph 2 had nothing to say.
  const chunks = textChunks([0, 1, 1, 1, 3, 4]);

  it.each([
    { index: 0, next: 1, previous: null },
    { index: 1, next: 4, previous: 0 },
    { index: 2, next: 4, previous: 0 },
    { index: 3, next: 4, previous: 0 },
    { index: 4, next: 5, previous: 1 },
    { index: 5, next: null, previous: 4 },
  ])("from chunk $index: next $next, previous $previous", ({ index, next, previous }) => {
    expect(nextParagraphChunk(chunks, index)).toBe(next);
    expect(previousParagraphChunk(chunks, index)).toBe(previous);
  });

  it.each([
    { paragraph: 0, chunk: 0 },
    { paragraph: 1, chunk: 1 },
    { paragraph: 2, chunk: 4 },
    { paragraph: 4, chunk: 5 },
    { paragraph: 5, chunk: null },
  ])("paragraph $paragraph starts at chunk $chunk", ({ paragraph, chunk }) => {
    expect(paragraphChunk(chunks, paragraph)).toBe(chunk);
  });

  it("has nowhere to go without chunks", () => {
    expect(nextParagraphChunk([], 0)).toBeNull();
    expect(previousParagraphChunk([], 0)).toBeNull();
    expect(paragraphChunk([], 0)).toBeNull();
  });
});
