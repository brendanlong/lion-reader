/**
 * @vitest-environment jsdom
 */

/**
 * `ArticleNarrator` against a fake `speechSynthesis` that, like real engines,
 * delivers a cancelled utterance's `end` event late — after the narrator has
 * already started the next utterance. A stale event must never advance the
 * narration, however late it arrives.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ArticleNarrator } from "@/lib/narration/ArticleNarrator";

class FakeUtterance {
  text: string;
  voice: unknown = null;
  rate = 1;
  pitch = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

/** Utterances spoken so far, and the cancelled ones whose `end` hasn't been delivered. */
let spoken: FakeUtterance[];
let cancelledPendingEnd: FakeUtterance[];

function speaking(): FakeUtterance | undefined {
  return spoken[spoken.length - 1];
}

function finishCurrent(): void {
  speaking()?.onend?.();
}

function deliverStaleEnds(): void {
  const stale = cancelledPendingEnd;
  cancelledPendingEnd = [];
  for (const utterance of stale) utterance.onend?.();
}

function useBrowser(userAgent: string): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
}

const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

const ARTICLE = "First.\n\nSecond.\n\nThird.";

beforeEach(() => {
  spoken = [];
  cancelledPendingEnd = [];
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("speechSynthesis", {
    speak: (utterance: FakeUtterance) => spoken.push(utterance),
    cancel: () => {
      const current = speaking();
      if (current && !cancelledPendingEnd.includes(current)) cancelledPendingEnd.push(current);
    },
    pause: () => {},
    resume: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function startedNarrator(): ArticleNarrator {
  const narrator = new ArticleNarrator();
  narrator.loadArticle(ARTICLE);
  narrator.play();
  return narrator;
}

describe("ArticleNarrator", () => {
  it("advances to the next paragraph when the current utterance ends", () => {
    useBrowser(CHROME);
    const narrator = startedNarrator();

    finishCurrent();

    expect(narrator.getState()).toMatchObject({ status: "playing", currentParagraph: 1 });
    expect(spoken.map((u) => u.text)).toEqual(["First.", "Second."]);
  });

  it("goes idle after the last paragraph ends", () => {
    useBrowser(CHROME);
    const narrator = startedNarrator();

    finishCurrent();
    finishCurrent();
    finishCurrent();

    expect(narrator.getState().status).toBe("idle");
    expect(spoken).toHaveLength(3);
  });

  it("ignores the cancelled utterance's late end after a Firefox pause and play", () => {
    useBrowser(FIREFOX);
    const narrator = startedNarrator();

    narrator.pause();
    narrator.play();
    deliverStaleEnds();

    expect(narrator.getState()).toMatchObject({ status: "playing", currentParagraph: 0 });
    expect(spoken.map((u) => u.text)).toEqual(["First.", "First."]);
  });

  it("ignores the cancelled utterance's late end after stop and play", () => {
    useBrowser(CHROME);
    const narrator = startedNarrator();
    finishCurrent();

    narrator.stop();
    narrator.play();
    deliverStaleEnds();

    expect(narrator.getState()).toMatchObject({ status: "playing", currentParagraph: 0 });
    expect(spoken.map((u) => u.text)).toEqual(["First.", "Second.", "First."]);
  });

  it("ignores a skipped utterance's end however late it arrives", () => {
    vi.useFakeTimers();
    useBrowser(CHROME);
    const narrator = startedNarrator();

    narrator.skipForward();
    vi.advanceTimersByTime(1000);
    deliverStaleEnds();

    expect(narrator.getState()).toMatchObject({ status: "playing", currentParagraph: 1 });
    expect(spoken.map((u) => u.text)).toEqual(["First.", "Second."]);

    finishCurrent();
    expect(narrator.getState().currentParagraph).toBe(2);
  });

  it("ignores every stale end after rapid skips", () => {
    useBrowser(CHROME);
    const narrator = startedNarrator();

    narrator.skipForward();
    narrator.skipForward();
    narrator.skipBackward();
    deliverStaleEnds();

    expect(narrator.getState()).toMatchObject({ status: "playing", currentParagraph: 1 });
    expect(spoken.map((u) => u.text)).toEqual(["First.", "Second.", "Third.", "Second."]);
  });

  it("ignores a cancelled utterance's late error", () => {
    useBrowser(CHROME);
    const narrator = startedNarrator();
    const first = speaking();
    vi.spyOn(console, "error").mockImplementation(() => {});

    narrator.skipForward();
    first?.onerror?.({ error: "synthesis-failed" });

    expect(narrator.getState()).toMatchObject({ status: "playing", currentParagraph: 1 });
  });

  it("stops on the current utterance's error", () => {
    useBrowser(CHROME);
    const narrator = startedNarrator();
    vi.spyOn(console, "error").mockImplementation(() => {});

    speaking()?.onerror?.({ error: "synthesis-failed" });

    expect(narrator.getState().status).toBe("idle");
  });

  it("resumes a skip made while paused from the new paragraph, ignoring the old end", () => {
    useBrowser(CHROME);
    const narrator = startedNarrator();

    narrator.pause();
    narrator.skipForward();
    expect(narrator.getState()).toMatchObject({ status: "paused", currentParagraph: 1 });

    narrator.play();
    deliverStaleEnds();

    expect(narrator.getState()).toMatchObject({ status: "playing", currentParagraph: 1 });
    expect(spoken.map((u) => u.text)).toEqual(["First.", "Second."]);
  });
});
