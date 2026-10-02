import { describe, it, expect } from "vitest";
import {
  MediaSourcePlayer,
  splitIntoSentenceChunks,
  splitIntoSpeechChunks,
  StreamInterruptedError,
  TransientSynthesisError,
  type PlaybackStatus,
} from "@/lib/narration/media-source-player";

describe("splitIntoSpeechChunks", () => {
  it("keeps short paragraphs whole and skips empty ones without renumbering", () => {
    expect(splitIntoSpeechChunks(["One.", "  ", "Two."], 100)).toEqual([
      { paragraph: 0, text: "One." },
      { paragraph: 2, text: "Two." },
    ]);
  });

  it("splits long paragraphs at sentence boundaries within the limit", () => {
    const paragraph = "First sentence here. Second sentence here. Third sentence here.";
    const chunks = splitIntoSpeechChunks([paragraph], 45);
    expect(chunks).toEqual([
      { paragraph: 0, text: "First sentence here. Second sentence here." },
      { paragraph: 0, text: "Third sentence here." },
    ]);
    expect(chunks.every((chunk) => chunk.text.length <= 45)).toBe(true);
  });

  it("hard-splits runs without whitespace that exceed the limit", () => {
    const url = `https://example.com/${"a".repeat(2500)}`;
    const chunks = splitIntoSpeechChunks([url], 1000);
    expect(chunks.length).toBe(3);
    expect(chunks.every((chunk) => chunk.text.length <= 1000)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(url);
  });
});

describe("splitIntoSentenceChunks", () => {
  it("makes each sentence its own chunk and skips empty paragraphs", () => {
    expect(splitIntoSentenceChunks(["One. Two.", " ", "Three."])).toEqual([
      { paragraph: 0, text: "One." },
      { paragraph: 0, text: "Two." },
      { paragraph: 2, text: "Three." },
    ]);
  });
});

/** The fake audio is one byte per millisecond. */
const SAMPLE_RATE = 1000;

class FakeTimeRanges {
  constructor(private readonly ranges: [number, number][]) {}
  get length(): number {
    return this.ranges.length;
  }
  start(i: number): number {
    return this.ranges[i][0];
  }
  end(i: number): number {
    return this.ranges[i][1];
  }
}

/**
 * A SourceBuffer in "sequence" mode as Chromium behaves: each append lands at
 * timestampOffset, which then advances to the end of the appended media.
 */
class FakeSourceBuffer extends EventTarget {
  mode = "segments";
  timestampOffset = 0;
  updating = false;
  ranges: [number, number][] = [];
  appended: { at: number; seconds: number }[] = [];
  removals: [number, number][] = [];
  aborts = 0;
  /** Evicts this range while the next append is still updating. */
  evictDuringNextAppend: [number, number] | null = null;

  get buffered(): FakeTimeRanges {
    return new FakeTimeRanges(this.ranges);
  }
  appendBuffer(bytes: Uint8Array): void {
    const seconds = bytes.length / SAMPLE_RATE;
    const at = this.timestampOffset;
    this.appended.push({ at, seconds });
    this.run(() => {
      this.addRange(at, at + seconds);
      this.timestampOffset = at + seconds;
    });
    if (this.evictDuringNextAppend) {
      const [start, end] = this.evictDuringNextAppend;
      this.evictDuringNextAppend = null;
      this.evict(start, end);
    }
  }
  /** Resets the parser, dropping any box an earlier append left unfinished. */
  abort(): void {
    if (this.updating) throw new Error("Aborting an update isn't modeled");
    this.aborts++;
  }
  remove(start: number, end: number): void {
    this.removals.push([start, end]);
    this.run(() => this.cut(start, end));
  }
  /** The browser evicting audio on its own (ManagedMediaSource). */
  evict(start: number, end: number): void {
    this.cut(start, end);
    this.dispatchEvent(new Event("bufferedchange"));
  }
  private cut(start: number, end: number): void {
    this.ranges = this.ranges.flatMap(([s, e]): [number, number][] => {
      const kept: [number, number][] = [];
      if (s < start) kept.push([s, Math.min(e, start)]);
      if (e > end) kept.push([Math.max(s, end), e]);
      return kept;
    });
  }
  private addRange(start: number, end: number): void {
    const merged: [number, number][] = [];
    for (const range of [...this.ranges, [start, end] as [number, number]].sort(
      (a, b) => a[0] - b[0]
    )) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    this.ranges = merged;
  }
  private run(change: () => void): void {
    if (this.updating) throw new Error("SourceBuffer is already updating");
    this.updating = true;
    setTimeout(() => {
      change();
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    }, 0);
  }
}

class FakeMediaSource extends EventTarget {
  readyState: "closed" | "open" | "ended" = "closed";
  buffers: FakeSourceBuffer[] = [];
  mimeTypes: string[] = [];
  endOfStreamCalls = 0;

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("sourceopen"));
  }
  addSourceBuffer(mimeType: string): FakeSourceBuffer {
    this.mimeTypes.push(mimeType);
    const buffer = new FakeSourceBuffer();
    this.buffers.push(buffer);
    return buffer;
  }
  endOfStream(): void {
    this.readyState = "ended";
    this.endOfStreamCalls++;
  }
  get buffer(): FakeSourceBuffer {
    return this.buffers[0];
  }
}

/** Stand-in for HTMLAudioElement (jsdom doesn't implement media playback). */
class FakeAudio extends EventTarget {
  paused = true;
  ended = false;
  private time = 0;
  /**
   * Like an MSE stream of unknown duration in Chromium, only buffered time is
   * seekable; a seek anywhere else is ignored.
   */
  isSeekable: (time: number) => boolean = () => true;
  preload = "";
  playbackRate = 1;
  defaultPlaybackRate = 1;
  disableRemotePlayback = false;
  /** Makes the next play() reject, like a play() interrupted by pause(). */
  rejectNextPlay: Error | null = null;

  play(): Promise<void> {
    this.paused = false;
    const error = this.rejectNextPlay;
    this.rejectNextPlay = null;
    return error ? Promise.reject(error) : Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  get currentTime(): number {
    return this.time;
  }
  set currentTime(time: number) {
    if (this.isSeekable(time)) this.time = time;
  }
  /** Playback reaching `time`. */
  advanceTo(time: number): void {
    this.time = time;
    this.dispatchEvent(new Event("timeupdate"));
  }
  /** The OS pausing the element (phone call, unplugged headphones). */
  pauseExternally(): void {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  end(): void {
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
    this.dispatchEvent(new Event("ended"));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * One chunk's synthesis, fed by the test: pieces of audio, then an end or a
 * failure. Aborting it fails the stream the way an aborted fetch does.
 */
class FakeSynthesis {
  readonly pieces: Uint8Array[] = [];
  private done = false;
  private error: Error | null = null;
  private waiters: (() => void)[] = [];

  constructor(readonly signal: AbortSignal) {
    signal.addEventListener("abort", () => this.wake());
  }

  get aborted(): boolean {
    return this.signal.aborted;
  }
  /** `seconds` more audio arriving. */
  push(seconds: number): void {
    this.pieces.push(new Uint8Array(Math.round(seconds * SAMPLE_RATE)));
    this.wake();
  }
  end(): void {
    this.done = true;
    this.wake();
  }
  fail(error: Error): void {
    this.error = error;
    this.wake();
  }
  async *stream(): AsyncGenerator<Uint8Array> {
    for (let next = 0; ;) {
      if (this.aborted) throw new DOMException("Aborted", "AbortError");
      if (next < this.pieces.length) yield this.pieces[next++];
      else if (this.error) throw this.error;
      else if (this.done) return;
      else await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
  private wake(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const MIME_TYPE = 'audio/mp4; codecs="mp4a.40.2"';

function setup(
  paragraphs: string[],
  {
    maxChars = 1000,
    maxConcurrentSyntheses = 4,
    bufferAheadSeconds = 4,
    mimeType = Promise.resolve(MIME_TYPE),
    supportsMse = true,
    retryDelaysMs = [0, 0, 0],
  }: {
    maxChars?: number;
    maxConcurrentSyntheses?: number;
    bufferAheadSeconds?: number;
    mimeType?: Promise<string>;
    supportsMse?: boolean;
    retryDelaysMs?: number[];
  } = {}
) {
  const audio = new FakeAudio();
  const sources: FakeMediaSource[] = [];
  audio.isSeekable = (time) =>
    sources[0]?.buffers[0]?.ranges.some(([start, end]) => start <= time && time < end) ?? false;
  const requests = new Map<string, FakeSynthesis>();
  const calls: string[] = [];
  const player = new MediaSourcePlayer({
    synthesize: (text, signal) => {
      const request = new FakeSynthesis(signal);
      calls.push(text);
      requests.set(text, request);
      return request.stream();
    },
    chunkParagraphs: (paragraphs) => splitIntoSpeechChunks(paragraphs, maxChars),
    maxConcurrentSyntheses,
    bufferAheadSeconds,
    // `respond` defaults to one second of audio per chunk.
    estimateSeconds: () => 1,
    retryDelaysMs,
    loadMimeType: () => mimeType,
    createAudio: () => audio as unknown as HTMLAudioElement,
    createMediaSource: () => {
      if (!supportsMse) return null;
      const source = new FakeMediaSource();
      sources.push(source);
      return source as unknown as MediaSource;
    },
    attach: (_audio, source) => {
      setTimeout(() => (source as unknown as FakeMediaSource).open(), 0);
      return () => {};
    },
  });
  const statuses: PlaybackStatus[] = [];
  const paragraphsSeen: number[] = [];
  const events = { ended: 0, errors: [] as Error[], interruptions: [] as Error[] };
  player.setCallbacks({
    onStatusChange: (status) => statuses.push(status),
    onPositionChange: (position) => paragraphsSeen.push(position.paragraph),
    onEnd: () => events.ended++,
    onError: (error) => events.errors.push(error),
    onInterrupted: (error) => events.interruptions.push(error),
  });
  player.load(paragraphs);
  /** Synthesis of `text` finishing with (another) `seconds` of audio. */
  const respond = async (text: string, seconds = 1) => {
    await stream(text, seconds);
    requests.get(text)!.end();
    await flush();
  };
  /** `seconds` more of `text`'s audio arriving, with more to come. */
  const stream = async (text: string, seconds: number) => {
    await flush();
    requests.get(text)!.push(seconds);
    await flush();
  };
  /** `text`'s synthesis failing after whatever it has delivered. */
  const failSynthesis = async (text: string, error: Error) => {
    await flush();
    requests.get(text)!.fail(error);
    await flush();
  };
  const buffer = () => sources[0].buffer;
  return {
    audio,
    sources,
    buffer,
    requests,
    calls,
    player,
    statuses,
    paragraphsSeen,
    events,
    respond,
    stream,
    failSynthesis,
  };
}

describe("MediaSourcePlayer", () => {
  it("appends every chunk to one stream in order and ends after the last", async () => {
    const { audio, sources, buffer, player, statuses, paragraphsSeen, events, respond } = setup([
      "A.",
      "B.",
    ]);
    player.prime();
    expect(audio.paused).toBe(false);

    void player.play();
    expect(player.getStatus()).toBe("buffering");

    await respond("A.", 2);
    expect(player.getStatus()).toBe("playing");
    expect(sources[0].mimeTypes).toEqual([MIME_TYPE]);
    expect(buffer().mode).toBe("sequence");

    await respond("B.", 3);
    expect(buffer().ranges).toEqual([[0, 5]]);
    expect(sources[0].endOfStreamCalls).toBe(1);

    audio.advanceTo(2.5);
    expect(paragraphsSeen).toEqual([0, 1]);

    audio.end();
    expect(events.ended).toBe(1);
    expect(player.getStatus()).toBe("idle");
    expect(statuses).toEqual(["buffering", "playing", "idle"]);
    expect(sources).toHaveLength(1);
  });

  it("keeps the configured seconds of audio synthesized past the playhead", async () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `${i}.`);
    const { audio, calls, player, respond } = setup(paragraphs); // 4 s ahead
    void player.play();
    await flush();
    expect(calls).toEqual(["0.", "1.", "2.", "3."]);

    for (const text of ["0.", "1.", "2.", "3."]) await respond(text);
    expect(calls).toHaveLength(4);

    audio.advanceTo(1.5); // 2.5 s buffered ahead, plus 1 s estimated each for 4 and 5
    await flush();
    expect(calls).toEqual(["0.", "1.", "2.", "3.", "4.", "5."]);
  });

  it("reaches further ahead when chunks turn out short", async () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `${i}.`);
    const { calls, player, respond } = setup(paragraphs, { maxConcurrentSyntheses: 20 });
    void player.play();
    for (const text of ["0.", "1.", "2.", "3."]) await respond(text, 0.25);

    // Only 1 s is really buffered, so three more (estimated 1 s) chunks are wanted.
    expect(calls).toEqual(["0.", "1.", "2.", "3.", "4.", "5.", "6."]);
  });

  it("tops up as the playhead moves within a long chunk", async () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `${i}.`);
    const { audio, calls, player, respond } = setup(paragraphs);
    void player.play();
    await respond("0.", 10);
    for (const text of ["1.", "2.", "3."]) await respond(text);
    expect(calls).toEqual(["0.", "1.", "2.", "3."]);

    audio.advanceTo(8.5); // chunk 0 has 1.5 s left; 1–3 bring it to 4.5 s
    await flush();
    expect(calls).toHaveLength(4);

    audio.advanceTo(9.5); // still chunk 0: 3.5 s ahead
    await flush();
    expect(calls).toEqual(["0.", "1.", "2.", "3.", "4."]);
  });

  it("measures the lookahead in listening time at the current rate", async () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `${i}.`);
    const { calls, player } = setup(paragraphs, { maxConcurrentSyntheses: 20 });
    player.setRate(2);
    void player.play();
    await flush();
    // 4 s at 2× is 8 s of audio.
    expect(calls).toHaveLength(8);
  });

  it("runs one synthesis at a time when limited, nearest chunk first", async () => {
    const { calls, player, respond } = setup(["1.", "2.", "3.", "4.", "5."], {
      maxConcurrentSyntheses: 1,
    });
    void player.play();
    await flush();
    expect(calls).toEqual(["1."]);
    await respond("1.");
    expect(calls).toEqual(["1.", "2."]);
    await respond("2.");
    expect(calls).toEqual(["1.", "2.", "3."]);
  });

  it("drops queued synthesis that a skip left behind", async () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `${i}.`);
    const { calls, player, respond } = setup(paragraphs, { maxConcurrentSyntheses: 1 });
    void player.play();
    await respond("0."); // chunks 1–3 now queued behind chunk 1's synthesis
    await player.skipTo(10);
    await respond("1.");

    // Chunk 10 goes next; 2 and 3 never start.
    expect(calls).toEqual(["0.", "1.", "10."]);
    await respond("10.");
    expect(player.getStatus()).toBe("playing");
    expect(calls).toEqual(["0.", "1.", "10.", "11."]);
  });

  it("doesn't synthesize text from before clearCache that was waiting on the format", async () => {
    const encoderLoad = deferred<string>();
    const { calls, player, respond } = setup(["Old 1.", "Old 2."], {
      maxConcurrentSyntheses: 1,
      mimeType: encoderLoad.promise,
    });
    void player.play();
    player.stop();
    player.clearCache();
    player.load(["New 1.", "New 2."]);
    void player.play();
    encoderLoad.resolve(MIME_TYPE);
    await respond("New 1.");

    expect(calls).toEqual(["New 1.", "New 2."]);
    expect(player.getStatus()).toBe("playing");
  });

  it("requests a dropped chunk again once playback gets near it", async () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `${i}.`);
    const { audio, calls, player, respond } = setup(paragraphs, { maxConcurrentSyntheses: 1 });
    void player.play();
    for (const text of ["0.", "1.", "2.", "3."]) await respond(text);
    audio.advanceTo(3.5); // chunk 4 synthesizing, 5 and 6 queued
    await flush();

    await player.skipBackward(); // back to 2, within the buffered run: 5 and 6 drop
    await player.skipBackward();
    await player.skipBackward();
    await respond("4.");
    expect(calls).toEqual(["0.", "1.", "2.", "3.", "4."]);

    audio.advanceTo(4.5);
    await flush();
    expect(calls).toEqual(["0.", "1.", "2.", "3.", "4.", "5."]);
  });

  it("buffers audio that arrives while paused and resumes in place", async () => {
    const { audio, buffer, player, respond } = setup(["A."]);
    void player.play();
    player.pause();
    await respond("A.");
    expect(player.getStatus()).toBe("paused");
    expect(audio.paused).toBe(true);

    await player.play();
    expect(player.getStatus()).toBe("playing");
    expect(audio.paused).toBe(false);
    expect(buffer().removals).toEqual([]);
  });

  it("reports buffering while the element waits for the next chunk", async () => {
    const { audio, player, respond } = setup(["A.", "B."]);
    void player.play();
    await respond("A.");
    audio.dispatchEvent(new Event("waiting"));
    expect(player.getStatus()).toBe("buffering");
    await respond("B.");
    audio.dispatchEvent(new Event("playing"));
    expect(player.getStatus()).toBe("playing");
  });

  it("seeks when skipping to a chunk that's already buffered", async () => {
    const { audio, buffer, calls, player, paragraphsSeen, respond } = setup(["A.", "B.", "C."]);
    void player.play();
    await respond("A.", 2);
    await respond("B.", 3);
    await respond("C.", 1);

    await player.skipForward();
    expect(audio.currentTime).toBe(2);
    expect(paragraphsSeen.at(-1)).toBe(1);

    audio.advanceTo(3);
    await player.skipBackward();
    expect(audio.currentTime).toBe(0);
    expect(paragraphsSeen.at(-1)).toBe(0);

    expect(calls).toEqual(["A.", "B.", "C."]);
    expect(buffer().removals).toEqual([]);
  });

  it("starts a new run at the playhead when skipping past what's buffered", async () => {
    const paragraphs = ["1.", "2.", "3.", "4.", "5.", "6."];
    const { audio, buffer, player, paragraphsSeen, respond } = setup(paragraphs);
    void player.play();
    for (const text of ["1.", "2.", "3.", "4."]) await respond(text);
    audio.advanceTo(0.5);

    await player.skipTo(5);
    expect(player.getStatus()).toBe("buffering");
    expect(paragraphsSeen.at(-1)).toBe(5);
    await respond("6.", 2);

    expect(buffer().removals).toEqual([[0, 4]]);
    expect(buffer().appended.at(-1)).toEqual({ at: 0.5, seconds: 2 });
    expect(player.getStatus()).toBe("playing");

    // Playback within the new run maps back to its chunk.
    audio.advanceTo(1);
    expect(paragraphsSeen.at(-1)).toBe(5);
  });

  it("skips by paragraph, not chunk", async () => {
    const long = "First sentence here. Second sentence here.";
    const { player, paragraphsSeen, respond } = setup([long, "Next."], { maxChars: 25 });
    void player.play();
    await respond("First sentence here.");
    await respond("Second sentence here.");
    await respond("Next.");
    await player.skipForward();
    expect(paragraphsSeen).toEqual([0, 1]);
    expect(player.getStatus()).toBe("playing");

    await player.skipBackward();
    expect(paragraphsSeen.at(-1)).toBe(0);
  });

  it("remembers a skip made while paused and starts there on play", async () => {
    const paragraphs = Array.from({ length: 50 }, (_, i) => `${i}.`);
    const { calls, requests, player, paragraphsSeen, respond } = setup(paragraphs);
    void player.play();
    await respond("0.");
    player.pause();
    await player.skipTo(40);
    expect(paragraphsSeen.at(-1)).toBe(40);

    // Prefetches already in flight finishing must not start paid synthesis
    // around the new spot before playback resumes.
    await respond("1.");
    expect(calls).toEqual(["0.", "1.", "2.", "3."]);

    void player.play();
    await respond("40.");
    expect(player.getStatus()).toBe("playing");
    // The skip stopped the syntheses it left behind, freeing their slots.
    expect(["1.", "2.", "3."].map((text) => requests.get(text)!.aborted)).toEqual([
      true,
      true,
      true,
    ]);
    expect(calls.slice(4)).toEqual(["40.", "41.", "42.", "43."]);
  });

  it("applies the playback rate to the element", async () => {
    const { audio, player } = setup(["A."]);
    player.setRate(1.5);
    void player.play();
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.defaultPlaybackRate).toBe(1.5);
  });

  it("stops and reports synthesis errors", async () => {
    const { requests, player, events } = setup(["A."]);
    void player.play();
    await flush();
    requests.get("A.")!.fail(new Error("boom"));
    await flush();
    expect(player.getStatus()).toBe("idle");
    expect(events.errors.map((error) => error.message)).toEqual(["boom"]);
  });

  it("retries a chunk that failed before", async () => {
    const { requests, player, respond } = setup(["A."]);
    void player.play();
    await flush();
    requests.get("A.")!.fail(new Error("boom"));
    await flush();
    void player.play();
    await flush();
    await respond("A.");
    expect(player.getStatus()).toBe("playing");
  });

  it("notices the OS pausing the element, so a later play resumes", async () => {
    const { audio, player, respond } = setup(["A."]);
    void player.play();
    await respond("A.");
    audio.pauseExternally();
    expect(player.getStatus()).toBe("paused");
    await player.play();
    expect(player.getStatus()).toBe("playing");
    expect(audio.paused).toBe(false);
  });

  it("treats a resume interrupted by a quick pause as a pause, not a failure", async () => {
    const { audio, player, events, respond } = setup(["A."]);
    void player.play();
    await respond("A.");
    player.pause();
    audio.rejectNextPlay = new DOMException("interrupted", "AbortError");
    const resumed = player.play();
    player.pause();
    await resumed;
    expect(player.getStatus()).toBe("paused");
    expect(events.errors).toEqual([]);
  });

  it("doesn't let a request from before clearCache drop its replacement", async () => {
    const { requests, calls, player, respond } = setup(["A."]);
    void player.play();
    await flush();
    const stale = requests.get("A.")!;
    player.stop();
    player.clearCache();
    void player.play();
    await flush();
    stale.push(1);
    stale.end();
    await flush();
    await respond("A.");
    expect(calls).toEqual(["A.", "A."]);
    expect(player.getStatus()).toBe("playing");
  });

  it("does nothing on next at the last paragraph, or previous at the first", async () => {
    const { audio, player, events, paragraphsSeen, respond } = setup(["A.", "B."]);
    void player.play();
    await respond("A.");
    await respond("B.");
    audio.advanceTo(0.5);
    await player.skipBackward();
    expect(audio.currentTime).toBe(0.5);

    audio.advanceTo(1.5);
    await player.skipForward();
    expect(audio.currentTime).toBe(1.5);
    expect(paragraphsSeen).toEqual([0, 1]);
    expect(events.ended).toBe(0);
    expect(player.getStatus()).toBe("playing");
  });

  it("doesn't ask again for a failed chunk ahead on every time update", async () => {
    const { audio, calls, player, events, stream, failSynthesis } = setup(["A.", "B.", "C."]);
    void player.play();
    await stream("A.", 1);
    await failSynthesis("B.", new Error("Rejected"));
    for (const time of [0.1, 0.2, 0.3]) audio.advanceTo(time);
    await flush();
    expect(calls).toEqual(["A.", "B.", "C."]);
    expect(events.errors).toEqual([]);
  });

  it("tries a chunk again after a wait when its failure may pass", async () => {
    const { calls, player, events, failSynthesis, respond } = setup(["A."], {
      retryDelaysMs: [30],
    });
    void player.play();
    await failSynthesis("A.", new TransientSynthesisError("Offline"));
    expect(calls).toEqual(["A."]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toEqual(["A.", "A."]);
    await respond("A.");
    expect(player.getStatus()).toBe("playing");
    expect(events.errors).toEqual([]);
  });

  it("pauses where it runs out once a chunk keeps failing, and play tries again", async () => {
    const { audio, calls, player, events, failSynthesis, respond } = setup(["A.", "B."], {
      retryDelaysMs: [0],
    });
    void player.play();
    await respond("A.");
    await failSynthesis("B.", new TransientSynthesisError("Offline"));
    await failSynthesis("B.", new TransientSynthesisError("Still offline"));
    // What's buffered plays on first.
    expect(player.getStatus()).toBe("playing");

    audio.advanceTo(1);
    audio.dispatchEvent(new Event("waiting"));
    expect(player.getStatus()).toBe("paused");
    expect(events.interruptions.map((error) => error.message)).toEqual(["Still offline"]);
    expect(events.errors).toEqual([]);

    void player.play();
    await respond("B.");
    expect(calls).toEqual(["A.", "B.", "B.", "B."]);
    expect(events.ended).toBe(0);
  });

  it("drops audio well behind the playhead", async () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `${i}.`);
    const { audio, buffer, player, respond } = setup(paragraphs);
    void player.play();
    for (let i = 0; i < 10; i++) {
      await respond(`${i}.`);
      audio.advanceTo(i + 0.5);
      await flush();
    }
    // Playing chunk 9 keeps chunks 4–9.
    expect(buffer().ranges).toEqual([[4, 10]]);
  });

  it("re-appends upcoming audio the browser evicted", async () => {
    const { buffer, calls, player, respond } = setup(["A.", "B.", "C."]);
    void player.play();
    await respond("A.");
    await respond("B.");
    await respond("C.");

    buffer().evict(1, 3);
    await flush();

    expect(buffer().ranges).toEqual([[0, 3]]);
    expect(buffer().appended.slice(-2)).toEqual([
      { at: 1, seconds: 1 },
      { at: 2, seconds: 1 },
    ]);
    expect(calls).toEqual(["A.", "B.", "C."]);
  });

  it("recovers audio evicted while one of its own appends was updating", async () => {
    const { buffer, player, respond } = setup(["A.", "B.", "C."]);
    void player.play();
    await respond("A.");
    await respond("B.");
    buffer().evictDuringNextAppend = [1, 2];
    await respond("C.");

    expect(buffer().ranges).toEqual([[0, 3]]);
  });

  it("reports an element that refuses the stream instead of buffering forever", async () => {
    const audio = new FakeAudio();
    const errors: string[] = [];
    const player = new MediaSourcePlayer({
      synthesize: async function* () {
        yield new Uint8Array(1000);
      },
      chunkParagraphs: (paragraphs) => splitIntoSpeechChunks(paragraphs, 1000),
      maxConcurrentSyntheses: 4,
      bufferAheadSeconds: 4,
      loadMimeType: async () => MIME_TYPE,
      createAudio: () => audio as unknown as HTMLAudioElement,
      createMediaSource: () => new FakeMediaSource() as unknown as MediaSource,
      attach: () => {
        setTimeout(() => audio.dispatchEvent(new Event("error")), 0);
        return () => {};
      },
    });
    player.setCallbacks({ onError: (error) => errors.push(error.message) });
    player.load(["A."]);
    player.prime();
    await flush();
    void player.play();
    await flush();

    expect(errors).toEqual(["Failed to open the narration audio stream"]);
    expect(player.getStatus()).toBe("idle");
  });

  it("reports browsers without Media Source Extensions", async () => {
    const { calls, player, events } = setup(["A."], { supportsMse: false });
    player.prime();
    await player.play();
    expect(events.errors.map((error) => error.message)).toEqual([
      "This browser can't stream narration audio",
    ]);
    expect(calls).toEqual([]);
  });

  it("reports a format the browser can't play without paying for synthesis", async () => {
    const { calls, player, events } = setup(["A.", "B."], {
      mimeType: Promise.reject(new Error("No AAC here")),
    });
    void player.play();
    await flush();
    expect(events.errors.map((error) => error.message)).toEqual(["No AAC here"]);
    expect(calls).toEqual([]);
  });
});

describe("MediaSourcePlayer with streamed audio", () => {
  it("plays a chunk's pieces as they arrive, its place on the timeline growing", async () => {
    const { audio, sources, buffer, player, paragraphsSeen, stream, respond, requests } = setup([
      "A.",
      "B.",
    ]);
    void player.play();
    await stream("A.", 1);
    expect(player.getStatus()).toBe("playing");
    expect(buffer().ranges).toEqual([[0, 1]]);

    await stream("A.", 2);
    expect(buffer().ranges).toEqual([[0, 3]]);
    audio.advanceTo(2.5);
    expect(paragraphsSeen).toEqual([0]);

    // The next chunk waits its turn, then follows the whole of the first.
    await respond("B.", 1);
    expect(buffer().ranges).toEqual([[0, 3]]);
    requests.get("A.")!.end();
    await flush();
    expect(buffer().ranges).toEqual([[0, 4]]);
    expect(sources[0].endOfStreamCalls).toBe(1);

    audio.advanceTo(3.5);
    expect(paragraphsSeen).toEqual([0, 1]);
  });

  it("waits for more of a chunk when playback catches up, then plays on", async () => {
    const { audio, sources, player, events, stream, requests } = setup(["A."]);
    void player.play();
    await stream("A.", 1);
    audio.advanceTo(1);
    audio.dispatchEvent(new Event("waiting"));
    expect(player.getStatus()).toBe("buffering");
    expect(sources[0].endOfStreamCalls).toBe(0);

    await stream("A.", 1);
    expect(player.getStatus()).toBe("playing");
    requests.get("A.")!.end();
    await flush();
    expect(sources[0].endOfStreamCalls).toBe(1);
    expect(events.ended).toBe(0);
  });

  it("seeks into and back out of a chunk that's still arriving", async () => {
    const { audio, buffer, calls, player, paragraphsSeen, stream, respond } = setup(["A.", "B."]);
    void player.play();
    await respond("A.", 2);
    await stream("B.", 1);

    await player.skipForward();
    expect(audio.currentTime).toBe(2);
    expect(paragraphsSeen.at(-1)).toBe(1);
    await player.skipBackward();
    expect(audio.currentTime).toBe(0);

    await stream("B.", 1);
    expect(buffer().ranges).toEqual([[0, 4]]);
    expect(buffer().removals).toEqual([]);
    expect(calls).toEqual(["A.", "B."]);
  });

  it("counts a chunk still arriving as at least its estimated length when looking ahead", async () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `${i}.`);
    const { calls, player, stream, requests } = setup(paragraphs, {
      maxConcurrentSyntheses: 20,
    });
    void player.play();
    await stream("0.", 0.25);
    expect(calls).toEqual(["0.", "1.", "2.", "3."]);

    // Only once it's over does it turn out short.
    requests.get("0.")!.end();
    await flush();
    expect(calls).toEqual(["0.", "1.", "2.", "3.", "4."]);
  });

  it("stops the synthesis of chunks a skip leaves behind", async () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `${i}.`);
    const { calls, requests, player, events, stream, respond } = setup(paragraphs);
    void player.play();
    await stream("0.", 1);
    await respond("1.");

    await player.skipTo(5);
    await flush();
    expect(requests.get("0.")!.aborted).toBe(true);
    expect(requests.get("1.")!.aborted).toBe(false); // already finished
    expect(requests.get("2.")!.aborted).toBe(true);
    expect(requests.get("3.")!.aborted).toBe(true);
    expect(calls.slice(4)).toEqual(["5.", "6.", "7.", "8."]);
    await respond("5.");
    expect(player.getStatus()).toBe("playing");
    expect(events.errors).toEqual([]);
  });

  it("stops every unfinished synthesis on stop", async () => {
    const { requests, player, stream, events } = setup(["A.", "B."]);
    void player.play();
    await stream("A.", 1);
    player.stop();
    await flush();
    expect(requests.get("A.")!.aborted).toBe(true);
    expect(requests.get("B.")!.aborted).toBe(true);
    expect(events.errors).toEqual([]);
  });

  it("synthesizes a chunk again when its stream drops before it plays", async () => {
    const { buffer, calls, player, stream, respond, failSynthesis } = setup(["A.", "B."]);
    void player.play();
    await stream("A.", 1);
    await stream("B.", 1);
    await failSynthesis("B.", new StreamInterruptedError());
    await respond("A.", 1);

    expect(calls).toEqual(["A.", "B.", "B."]);
    await respond("B.", 3);
    expect(buffer().ranges).toEqual([[0, 5]]);
    expect(player.getStatus()).toBe("playing");
  });

  it("replays a chunk from its start, without duplicating it, when its stream drops partway", async () => {
    const {
      audio,
      buffer,
      calls,
      player,
      paragraphsSeen,
      statuses,
      stream,
      respond,
      failSynthesis,
    } = setup(["A.", "B."]);
    void player.play();
    await respond("A.", 1);
    await stream("B.", 1);
    await stream("B.", 1);
    audio.advanceTo(2.5);
    expect(paragraphsSeen).toEqual([0, 1]);

    await failSynthesis("B.", new StreamInterruptedError());
    expect(player.getStatus()).toBe("buffering");
    expect(buffer().removals).toEqual([[1, 3]]);
    // The dropped stream may have stopped mid-box; the retry is a new file.
    expect(buffer().aborts).toBe(2);
    expect(calls).toEqual(["A.", "B.", "B."]);

    await respond("B.", 1.5);
    // Back to the chunk's start, once there's audio there to seek to.
    expect(audio.currentTime).toBe(1);
    expect(buffer().ranges).toEqual([[0, 2.5]]);
    expect(buffer().appended.at(-1)).toEqual({ at: 1, seconds: 1.5 });
    expect(player.getStatus()).toBe("playing");
    expect(statuses.at(-1)).toBe("playing");
  });

  it("pauses on a chunk whose stream keeps dropping, without playing what it had", async () => {
    const { audio, buffer, calls, player, events, stream, failSynthesis } = setup(["A."]);
    void player.play();
    for (let attempt = 0; attempt < 3; attempt++) {
      await stream("A.", 1);
      await failSynthesis("A.", new StreamInterruptedError());
    }
    expect(calls).toEqual(["A.", "A.", "A."]);
    expect(buffer().ranges).toEqual([]);
    audio.dispatchEvent(new Event("waiting"));
    expect(player.getStatus()).toBe("paused");
    expect(events.errors).toEqual([]);
    expect(events.interruptions.map((error) => error.message)).toEqual([
      new StreamInterruptedError().message,
    ]);
  });

  it("reports a failure that isn't a dropped stream without retrying", async () => {
    const { calls, player, events, stream, failSynthesis } = setup(["A."]);
    void player.play();
    await stream("A.", 1);
    await failSynthesis("A.", new Error("Couldn't decode"));
    expect(calls).toEqual(["A."]);
    expect(events.errors.map((error) => error.message)).toEqual(["Couldn't decode"]);
  });
});

describe("MediaSourcePlayer prime leases", () => {
  it("releases a prime whose playback never started", () => {
    const { audio, player } = setup(["A."]);
    const lease = player.prime();
    expect(audio.paused).toBe(false);

    player.releasePrime(lease);

    expect(audio.paused).toBe(true);
    expect(player.getStatus()).toBe("idle");
  });

  it("ignores an abandoned request's release once a newer one has primed and started", async () => {
    // Request A primes, then is abandoned while its narration generates; B
    // primes and starts playing. A finishing late must not stop B.
    const { audio, player, respond } = setup(["B."]);
    const abandoned = player.prime();
    player.stop(); // the variant toggle / reset that abandoned A
    player.prime();
    void player.play();
    await respond("B.");
    expect(player.getStatus()).toBe("playing");

    player.releasePrime(abandoned);

    expect(player.getStatus()).toBe("playing");
    expect(audio.paused).toBe(false);
  });
});
