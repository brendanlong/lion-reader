import { describe, it, expect } from "vitest";
import { MediaSourcePlayer, splitIntoSpeechChunks } from "@/lib/narration/media-source-player";
import type { PcmAudio, SegmentEncoder } from "@/lib/narration/audio-encoding";
import type { PlaybackStatus } from "@/lib/narration/streaming-audio-player";

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

/** The fake encoder writes one byte per millisecond of audio. */
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
  currentTime = 0;
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
  /** Playback reaching `time`. */
  advanceTo(time: number): void {
    this.currentTime = time;
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

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const fakeEncoder: SegmentEncoder = {
  mimeType: 'audio/mp4; codecs="mp4a.40.2"',
  encode: async (audio) => new Uint8Array(audio.samples.length),
};

function setup(
  paragraphs: string[],
  {
    maxChars = 1000,
    encoder = fakeEncoder as SegmentEncoder | null,
    supportsMse = true,
  }: { maxChars?: number; encoder?: SegmentEncoder | null; supportsMse?: boolean } = {}
) {
  const audio = new FakeAudio();
  const sources: FakeMediaSource[] = [];
  const requests = new Map<string, ReturnType<typeof deferred<PcmAudio>>>();
  const calls: string[] = [];
  const player = new MediaSourcePlayer({
    synthesize: (text) => {
      const request = deferred<PcmAudio>();
      calls.push(text);
      requests.set(text, request);
      return request.promise;
    },
    maxChunkChars: maxChars,
    loadEncoder: async () => encoder,
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
  const events = { ended: 0, errors: [] as Error[] };
  player.setCallbacks({
    onStatusChange: (status) => statuses.push(status),
    onPositionChange: (position) => paragraphsSeen.push(position.paragraph),
    onEnd: () => events.ended++,
    onError: (error) => events.errors.push(error),
  });
  player.load(paragraphs);
  /** Synthesis of `text` finishing with `seconds` of audio. */
  const respond = async (text: string, seconds = 1) => {
    await flush();
    requests.get(text)!.resolve({
      samples: new Float32Array(Math.round(seconds * SAMPLE_RATE)),
      sampleRate: SAMPLE_RATE,
    });
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
    expect(sources[0].mimeTypes).toEqual([fakeEncoder.mimeType]);
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

  it("synthesizes a bounded number of chunks ahead of the one playing", async () => {
    const { audio, calls, player, respond } = setup(["1.", "2.", "3.", "4.", "5.", "6."]);
    void player.play();
    await flush();
    expect(calls).toEqual(["1.", "2.", "3.", "4."]);

    for (const text of ["1.", "2.", "3.", "4."]) await respond(text);
    expect(calls).toHaveLength(4);

    audio.advanceTo(1.5); // into chunk 2
    await flush();
    expect(calls).toEqual(["1.", "2.", "3.", "4.", "5."]);
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
    const { calls, player, paragraphsSeen, respond } = setup(["A.", "B.", "C.", "D.", "E."]);
    void player.play();
    await respond("A.");
    player.pause();
    await player.skipTo(4);
    expect(paragraphsSeen.at(-1)).toBe(4);
    expect(calls).not.toContain("E.");

    void player.play();
    await respond("E.");
    expect(player.getStatus()).toBe("playing");
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
    requests.get("A.")!.reject(new Error("boom"));
    await flush();
    expect(player.getStatus()).toBe("idle");
    expect(events.errors.map((error) => error.message)).toEqual(["boom"]);
  });

  it("retries a chunk that failed before", async () => {
    const { requests, player, respond } = setup(["A."]);
    void player.play();
    await flush();
    requests.get("A.")!.reject(new Error("boom"));
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
    stale.resolve({ samples: new Float32Array(1), sampleRate: SAMPLE_RATE });
    await flush();
    await respond("A.");
    expect(calls).toEqual(["A.", "A."]);
    expect(player.getStatus()).toBe("playing");
  });

  it("ends cleanly when skipping past the last paragraph", async () => {
    const { player, events, respond } = setup(["A."]);
    void player.play();
    await respond("A.");
    await player.skipForward();
    expect(events.ended).toBe(1);
    expect(player.getStatus()).toBe("idle");
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

  it("reports browsers without Media Source Extensions", async () => {
    const { calls, player, events } = setup(["A."], { supportsMse: false });
    player.prime();
    await player.play();
    expect(events.errors.map((error) => error.message)).toEqual([
      "This browser can't stream narration audio",
    ]);
    expect(calls).toEqual([]);
  });

  it("reports a missing encoder without paying for synthesis", async () => {
    const { calls, player, events } = setup(["A.", "B."], { encoder: null });
    void player.play();
    await flush();
    expect(events.errors.map((error) => error.message)).toEqual([
      "This browser can't stream narration audio",
    ]);
    expect(calls).toEqual([]);
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
