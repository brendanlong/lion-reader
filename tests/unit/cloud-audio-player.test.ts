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
});

/** Stand-in for HTMLAudioElement (jsdom doesn't implement media playback). */
class FakeAudio extends EventTarget {
  loop = false;
  paused = true;
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
    return Promise.resolve();
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
  const player = new CloudAudioPlayer(
    (text) => {
      const request = deferred<Blob>();
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
  return { audio, requests, player, statuses, paragraphsSeen, events, respond };
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
});
