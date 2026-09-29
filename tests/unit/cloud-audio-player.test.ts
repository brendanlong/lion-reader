import { describe, it, expect } from "vitest";
import { CloudAudioPlayer, splitIntoSpeechChunks } from "@/lib/narration/cloud-audio-player";
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

/** Stand-in for HTMLAudioElement (jsdom doesn't implement media playback). */
class FakeAudio extends EventTarget {
  loop = false;
  paused = true;
  ended = false;
  /** Makes the next play() reject, like a play() interrupted by pause(). */
  rejectNextPlay: Error | null = null;
  preload = "";
  playbackRate = 1;
  defaultPlaybackRate = 1;
  private source = "";

  get src(): string {
    return this.source;
  }
  set src(value: string) {
    this.source = value;
    this.playbackRate = this.defaultPlaybackRate;
  }
  removeAttribute(name: string): void {
    if (name === "src") this.source = "";
  }
  play(): Promise<void> {
    this.paused = false;
    const error = this.rejectNextPlay;
    this.rejectNextPlay = null;
    return error ? Promise.reject(error) : Promise.resolve();
  }
  /** The OS pausing the element (phone call, unplugged headphones). */
  pauseExternally(): void {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  pause(): void {
    this.paused = true;
  }
  end(): void {
    this.dispatchEvent(new Event("ended"));
  }
  get isSilence(): boolean {
    return this.source.startsWith("data:audio/wav");
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(paragraphs: string[], maxChars = 1000) {
  const audio = new FakeAudio();
  const requests = new Map<string, ReturnType<typeof deferred<Blob>>>();
  const calls: string[] = [];
  const player = new CloudAudioPlayer(
    (text) => {
      const request = deferred<Blob>();
      calls.push(text);
      requests.set(text, request);
      return request.promise;
    },
    maxChars,
    () => audio as unknown as HTMLAudioElement
  );
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
  const respond = async (text: string) => {
    requests.get(text)!.resolve(new Blob([text], { type: "audio/mpeg" }));
    await flush();
  };
  return { audio, requests, calls, player, statuses, paragraphsSeen, events, respond };
}

describe("CloudAudioPlayer", () => {
  it("loops silence while buffering, then plays each chunk in order", async () => {
    const { audio, player, statuses, paragraphsSeen, events, respond } = setup(["A.", "B."]);
    player.prime();
    expect(audio.isSilence).toBe(true);
    expect(audio.loop).toBe(true);

    void player.play();
    expect(player.getStatus()).toBe("buffering");
    expect(audio.isSilence).toBe(true);

    await respond("A.");
    expect(player.getStatus()).toBe("playing");
    expect(audio.src).toMatch(/^blob:/);
    expect(audio.loop).toBe(false);

    await respond("B."); // prefetched while A plays
    audio.end();
    await flush();
    expect(audio.isSilence).toBe(false);
    expect(paragraphsSeen).toEqual([0, 1]);

    audio.end();
    await flush();
    expect(events.ended).toBe(1);
    expect(player.getStatus()).toBe("idle");
    expect(statuses).toEqual(["buffering", "playing", "idle"]);
  });

  it("prefetches a bounded number of chunks ahead", async () => {
    const { requests, player } = setup(["1.", "2.", "3.", "4.", "5.", "6."]);
    void player.play();
    expect([...requests.keys()]).toEqual(["1.", "2.", "3.", "4."]);
  });

  it("doesn't start a chunk that arrives while paused, and resumes it on play", async () => {
    const { audio, player, respond } = setup(["A."]);
    void player.play();
    player.pause();
    await respond("A.");
    expect(player.getStatus()).toBe("paused");
    expect(audio.src).not.toMatch(/^blob:/);

    await player.play();
    expect(player.getStatus()).toBe("playing");
    expect(audio.src).toMatch(/^blob:/);
  });

  it("resumes a paused clip in place", async () => {
    const { audio, player, respond } = setup(["A."]);
    void player.play();
    await respond("A.");
    const src = audio.src;
    player.pause();
    expect(audio.paused).toBe(true);
    await player.play();
    expect(audio.src).toBe(src);
    expect(audio.paused).toBe(false);
  });

  it("skips by paragraph, not chunk", async () => {
    const long = "First sentence here. Second sentence here.";
    const { player, paragraphsSeen, respond } = setup([long, "Next."], 25);
    void player.play();
    await respond("First sentence here.");
    const skipped = player.skipForward();
    await respond("Next.");
    await skipped;
    expect(paragraphsSeen).toEqual([0, 1]);
    expect(player.getStatus()).toBe("playing");

    await player.skipBackward();
    expect(paragraphsSeen.at(-1)).toBe(0);
  });

  it("applies the playback rate to every chunk", async () => {
    const { audio, player, respond } = setup(["A."]);
    player.setRate(1.5);
    void player.play();
    await respond("A.");
    expect(audio.playbackRate).toBe(1.5);
  });

  it("stops and reports synthesis errors", async () => {
    const { requests, player, events } = setup(["A."]);
    void player.play();
    requests.get("A.")!.reject(new Error("boom"));
    await flush();
    expect(player.getStatus()).toBe("idle");
    expect(events.errors.map((error) => error.message)).toEqual(["boom"]);
  });

  it("retries a chunk that failed before", async () => {
    const { requests, player, respond } = setup(["A."]);
    void player.play();
    requests.get("A.")!.reject(new Error("boom"));
    await flush();
    void player.play();
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

  it("ignores the pause event from its own src swaps", async () => {
    const { audio, player, respond } = setup(["A.", "B."]);
    void player.play();
    await respond("A.");
    await respond("B.");
    audio.end();
    await flush();
    // A src swap on a playing element fires "pause" asynchronously, after
    // play() has already resumed it.
    audio.dispatchEvent(new Event("pause"));
    expect(player.getStatus()).toBe("playing");
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
    const stale = requests.get("A.")!;
    player.stop();
    player.clearCache();
    void player.play();
    stale.resolve(new Blob(["old"]));
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
});

describe("CloudAudioPlayer prime leases", () => {
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
