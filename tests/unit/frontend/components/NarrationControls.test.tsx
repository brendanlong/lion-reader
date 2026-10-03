/**
 * @vitest-environment jsdom
 */

/**
 * Narration playback controls, driven through the real `useNarration` engine.
 *
 * Narration spans two index spaces and the controls are where they meet:
 * `state.currentParagraph` is a **DOM element** index (translated through the
 * paragraph map so highlighting lands on the right element), while
 * `state.totalParagraphs` counts **narration paragraphs** — the segments the
 * player actually speaks. The map is not the identity (one element can narrate
 * as several paragraphs, and an element can narrate as none), so the skip
 * bounds and the "X of Y" readout must use `state.currentNarrationParagraph`.
 *
 * These tests use the real hook, the real `ArticleNarrator`, and real HTML with
 * a deliberately non-identity paragraph map; the only stand-ins are the browser
 * primitives jsdom lacks (`speechSynthesis`, `SpeechSynthesisUtterance`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";
import { NarrationControlsImpl } from "@/components/narration/NarrationControls";
import { FloatingNarrationControls } from "@/components/narration/FloatingNarrationControls";
import { useNarration } from "@/components/narration/useNarration";
import { htmlToClientNarration } from "@/lib/narration/client-paragraph-ids";
import { renderWithTrpc, stubMemoryLocalStorage } from "../../../utils/component-test-helpers";

/**
 * Two `<p>` elements that each narrate as several paragraphs (`<br><br>` splits
 * one element's text) and two that narrate as none (they are still numbered as
 * highlight targets), so the map is `o = [0, 0, 2, 3, 3, 3, 5]` over 7 narration
 * paragraphs — the DOM index runs behind the narration index throughout.
 */
const SKEWED_HTML =
  "<p>Alpha<br><br>Beta</p>" +
  "<p></p>" +
  "<p>Gamma</p>" +
  "<p>Delta<br><br>Epsilon<br><br>Zeta</p>" +
  "<p></p>" +
  "<p>Eta</p>";

/**
 * The opposite skew: silent elements between spoken ones push the DOM index
 * *ahead* of the narration index (`o = [0, 3, 6]` over 3 narration paragraphs).
 */
const SPARSE_HTML = "<p>One</p><p></p><p></p><p>Two</p><p></p><p></p><p>Three</p>";

interface SpeechStub {
  speak: Mock;
  cancel: Mock;
  pause: Mock;
  resume: Mock;
  getVoices: Mock;
  onvoiceschanged: (() => void) | null;
}

let speech: SpeechStub;

beforeEach(() => {
  stubMemoryLocalStorage();

  const voice = {
    voiceURI: "test-voice",
    name: "Test Voice",
    lang: "en-US",
    default: true,
    localService: true,
  };

  speech = {
    speak: vi.fn(),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    getVoices: vi.fn(() => [voice]),
    onvoiceschanged: null,
  };
  vi.stubGlobal("speechSynthesis", speech);
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      text: string;
      voice: unknown = null;
      rate = 1;
      pitch = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The real wiring: the owner holds `useNarration` (it needs the DOM index for
 * highlighting) and hands the whole engine to the controls.
 */
function NarrationHarness({
  content,
  showFullContent = false,
}: {
  content: string;
  showFullContent?: boolean;
}) {
  const narration = useNarration({
    id: "entry-1",
    title: "Test article",
    feedTitle: "Test feed",
    content,
    showFullContent,
  });
  return <NarrationControlsImpl narration={narration} />;
}

function renderHarness(content: string, showFullContent = false) {
  return renderWithTrpc(<NarrationHarness content={content} showFullContent={showFullContent} />, {
    wrapper: (children) => <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>,
  });
}

/** Clicks "Listen" and waits for the first paragraph to be speaking. */
async function startNarration() {
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument());
}

const nextButton = () => screen.getByRole("button", { name: "Next paragraph" });
const previousButton = () => screen.getByRole("button", { name: "Previous paragraph" });

describe("narration paragraph fixtures", () => {
  it("SKEWED_HTML narrates 7 paragraphs over a non-identity map", () => {
    const { narrationText, paragraphMap } = htmlToClientNarration(SKEWED_HTML);

    expect(narrationText.split("\n\n")).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epsilon",
      "Zeta",
      "Eta",
    ]);
    expect(paragraphMap.map((entry) => entry.o)).toEqual([0, 0, 2, 3, 3, 3, 5]);
  });

  it("SPARSE_HTML narrates 3 paragraphs whose DOM indices run ahead", () => {
    const { narrationText, paragraphMap } = htmlToClientNarration(SPARSE_HTML);

    expect(narrationText.split("\n\n")).toEqual(["One", "Two", "Three"]);
    expect(paragraphMap.map((entry) => entry.o)).toEqual([0, 3, 6]);
  });
});

describe("NarrationControls paragraph position", () => {
  it("counts narration paragraphs, not the DOM elements they highlight", async () => {
    renderHarness(SKEWED_HTML);
    await startNarration();

    // Narration paragraph 0 ("Alpha") — nothing before it.
    expect(screen.getByText("1 of 7")).toBeInTheDocument();
    expect(previousButton()).toBeDisabled();
    expect(nextButton()).toBeEnabled();

    // Narration paragraph 1 ("Beta") still highlights DOM element 0, so a
    // DOM-index comparison would call this the very first paragraph.
    fireEvent.click(nextButton());
    await waitFor(() => expect(screen.getByText("2 of 7")).toBeInTheDocument());
    expect(previousButton()).toBeEnabled();
  });

  it("keeps Next live until the last narration paragraph", async () => {
    renderHarness(SKEWED_HTML);
    await startNarration();

    for (let i = 1; i < 6; i++) {
      fireEvent.click(nextButton());
      await waitFor(() => expect(screen.getByText(`${i + 1} of 7`)).toBeInTheDocument());
      expect(nextButton()).toBeEnabled();
    }

    // Narration paragraph 6 ("Eta") is the last one, even though it highlights
    // DOM element 5.
    fireEvent.click(nextButton());
    await waitFor(() => expect(screen.getByText("7 of 7")).toBeInTheDocument());
    expect(nextButton()).toBeDisabled();
  });

  it("does not disable Next early when DOM indices run ahead of narration ones", async () => {
    renderHarness(SPARSE_HTML);
    await startNarration();

    // Narration paragraph 1 ("Two") highlights DOM element 3, which is already
    // past `totalParagraphs - 1` (2) — but "Three" is still to come.
    fireEvent.click(nextButton());
    await waitFor(() => expect(screen.getByText("2 of 3")).toBeInTheDocument());
    expect(nextButton()).toBeEnabled();

    fireEvent.click(nextButton());
    await waitFor(() => expect(screen.getByText("3 of 3")).toBeInTheDocument());
    expect(nextButton()).toBeDisabled();
  });

  it("enables Shift+P once a narration paragraph has been played", async () => {
    renderHarness(SKEWED_HTML);
    await startNarration();

    fireEvent.keyDown(document, { key: "N", code: "KeyN", shiftKey: true });
    await waitFor(() => expect(screen.getByText("2 of 7")).toBeInTheDocument());

    // The DOM index is still 0 here, which would leave Shift+P disabled.
    fireEvent.keyDown(document, { key: "P", code: "KeyP", shiftKey: true });
    await waitFor(() => expect(screen.getByText("1 of 7")).toBeInTheDocument());
  });
});

describe("NarrationControls content variant switching", () => {
  it("stops speaking the old variant when the displayed variant changes", async () => {
    const { rerender } = renderHarness(SKEWED_HTML);
    await startNarration();
    expect(speech.speak).toHaveBeenCalledTimes(1);

    const cancelsBefore = speech.cancel.mock.calls.length;

    // Toggling "Full Content" does not remount the entry (EntryContent is keyed
    // only by the entry id), so the hook has to stop the utterance itself.
    rerender(<NarrationHarness content={SKEWED_HTML} showFullContent={true} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Listen" })).toBeInTheDocument());
    expect(speech.cancel.mock.calls.length).toBeGreaterThan(cancelsBefore);
    expect(speech.speak).toHaveBeenCalledTimes(1);
  });
});

describe("playFromElement", () => {
  function SeekHarness({ content, elementIndex }: { content: string; elementIndex: number }) {
    const narration = useNarration({
      id: "entry-1",
      title: "Test article",
      feedTitle: "Test feed",
      content,
    });
    return (
      <>
        <NarrationControlsImpl narration={narration} />
        <button onClick={() => narration.playFromElement(elementIndex)}>Seek</button>
      </>
    );
  }

  function renderSeekHarness(elementIndex: number) {
    return renderWithTrpc(<SeekHarness content={SKEWED_HTML} elementIndex={elementIndex} />, {
      wrapper: (children) => <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>,
    });
  }

  const lastSpoken = () => (speech.speak.mock.lastCall?.[0] as { text: string }).text;

  it("speaks from the first narration paragraph of the chosen element", async () => {
    renderSeekHarness(3);
    await startNarration();

    fireEvent.click(screen.getByRole("button", { name: "Seek" }));

    await waitFor(() => expect(screen.getByText("4 of 7")).toBeInTheDocument());
    expect(lastSpoken()).toBe("Delta");
  });

  it("skips ahead to the next narrated element when the chosen one is silent", async () => {
    renderSeekHarness(1);
    await startNarration();

    fireEvent.click(screen.getByRole("button", { name: "Seek" }));

    await waitFor(() => expect(screen.getByText("3 of 7")).toBeInTheDocument());
    expect(lastSpoken()).toBe("Gamma");
  });

  it("moves while paused, staying paused, and resumes from there", async () => {
    renderSeekHarness(5);
    await startNarration();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Seek" }));

    await waitFor(() => expect(screen.getByText("7 of 7")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(speech.speak).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument());
    expect(lastSpoken()).toBe("Eta");
  });
});

describe("ArticleNarrator at the ends of the article", () => {
  it("does nothing on previous at the first paragraph, or next at the last", async () => {
    const { ArticleNarrator } = await import("@/lib/narration/ArticleNarrator");
    const narrator = new ArticleNarrator();
    narrator.loadArticle("First.\n\nLast.");
    narrator.play();
    narrator.skipBackward();
    expect(narrator.getState()).toMatchObject({ status: "playing", currentParagraph: 0 });
    narrator.skipForward();
    narrator.skipForward();
    expect(narrator.getState()).toMatchObject({ status: "playing", currentParagraph: 1 });
    expect(speech.speak.mock.calls.map(([utterance]) => utterance.text)).toEqual([
      "First.",
      "Last.",
    ]);
  });
});

describe("FloatingNarrationControls", () => {
  function FloatingHarness() {
    const narration = useNarration({
      id: "entry-1",
      title: "Test article",
      feedTitle: "Test feed",
      content: SKEWED_HTML,
    });
    return (
      <>
        <NarrationControlsImpl narration={narration} />
        <div data-testid="floating">
          <FloatingNarrationControls narration={narration} />
        </div>
      </>
    );
  }

  it("appears only once narration is active and drives the same engine", async () => {
    renderWithTrpc(<FloatingHarness />, {
      wrapper: (children) => <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>,
    });
    const floating = screen.getByTestId("floating");
    expect(floating).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(within(floating).getByText("1/7")).toBeInTheDocument());

    fireEvent.click(within(floating).getByRole("button", { name: "Next paragraph" }));
    await waitFor(() => expect(within(floating).getByText("2/7")).toBeInTheDocument());
    expect(screen.getByText("2 of 7")).toBeInTheDocument();

    fireEvent.click(within(floating).getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(within(floating).getByRole("button", { name: "Resume" })).toBeInTheDocument()
    );
  });
});

/**
 * With LLM normalization on, narration text comes from a (slow) server call.
 * If the user closes the entry or switches the displayed variant before it
 * returns, the result belongs to nobody: speaking it would start the page-global
 * speech engine with no controls on screen, and storing it would pair the new
 * variant with the old variant's text and paragraph map.
 */
describe("narration that finishes generating after the user moved on", () => {
  /** A `narration.generate` whose responses wait for `release()`. */
  function deferredGenerate() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = async () => {
      await gate;
      return {
        narration: "Server narration.",
        cached: false,
        source: "llm" as const,
        paragraphMap: [{ n: 0, o: 0 }],
      };
    };
    return { handler, release };
  }

  function renderLlmHarness(handler: () => Promise<unknown>) {
    return renderWithTrpc(<NarrationHarness content={SKEWED_HTML} />, {
      handlers: { "narration.generate": handler },
      wrapper: (children) => <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>,
    });
  }

  /** Lets the released request run through to wherever it would start speaking. */
  async function settle(release: () => void) {
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  beforeEach(() => {
    localStorage.setItem(
      "lion-reader-narration-settings",
      JSON.stringify({ useLlmNormalization: true })
    );
  });

  it("speaks the server narration when nothing changed while it generated", async () => {
    const generate = deferredGenerate();
    const { callsFor } = renderLlmHarness(generate.handler);
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(callsFor("narration.generate")).toHaveLength(1));

    await settle(generate.release);

    expect(speech.speak).toHaveBeenCalledTimes(1);
    expect((speech.speak.mock.lastCall?.[0] as { text: string }).text).toBe("Server narration.");
  });

  it("doesn't start speaking after the entry is closed", async () => {
    const generate = deferredGenerate();
    const { callsFor, unmount } = renderLlmHarness(generate.handler);
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(callsFor("narration.generate")).toHaveLength(1));

    unmount();
    await settle(generate.release);

    expect(speech.speak).not.toHaveBeenCalled();
  });

  it("drops the old variant's narration when the variant changes mid-generation", async () => {
    const generate = deferredGenerate();
    const { callsFor, rerender } = renderLlmHarness(generate.handler);
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(callsFor("narration.generate")).toHaveLength(1));

    rerender(<NarrationHarness content={SKEWED_HTML} showFullContent={true} />);
    await settle(generate.release);

    expect(speech.speak).not.toHaveBeenCalled();
    // Back to idle, and the next play narrates the variant now on screen rather
    // than reusing the stale text.
    fireEvent.click(await screen.findByRole("button", { name: "Listen" }));
    await waitFor(() => expect(speech.speak).toHaveBeenCalledTimes(1));
    const calls = callsFor("narration.generate");
    expect(calls).toHaveLength(2);
    expect(calls[1].input).toMatchObject({ showFullContent: true });
  });

  it("doesn't let an abandoned cloud request stop the playback that replaced it", async () => {
    localStorage.setItem(
      "lion-reader-narration-settings",
      JSON.stringify({ useLlmNormalization: true, provider: "cloud" })
    );
    // jsdom has the element but not media playback, Media Source Extensions
    // or object URLs. The stub source never opens, so B stays buffering (which
    // still shows "Pause") — enough to see whether A's release stops it.
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = () => "blob:stream";
        static revokeObjectURL = () => {};
      }
    );
    vi.stubGlobal(
      "MediaSource",
      class extends EventTarget {
        static isTypeSupported = () => true;
      }
    );
    // Speech that never arrives.
    vi.stubGlobal("fetch", () => new Promise(() => {}));

    // The first generate (A) waits for release(); later ones answer at once.
    const first = deferredGenerate();
    let generateCalls = 0;
    const { callsFor, rerender } = renderWithTrpc(<NarrationHarness content={SKEWED_HTML} />, {
      handlers: {
        "narration.generate": () =>
          generateCalls++ === 0
            ? first.handler()
            : { narration: "Newer narration.", cached: false, source: "llm", paragraphMap: [] },
      },
      wrapper: (children) => <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>,
    });

    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(callsFor("narration.generate")).toHaveLength(1));

    // Switching the variant abandons A, and B starts playing before A returns.
    rerender(<NarrationHarness content={SKEWED_HTML} showFullContent={true} />);
    fireEvent.click(await screen.findByRole("button", { name: "Listen" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument());

    await settle(first.release);

    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("shows the new variant as generating, not mid-playback in the old one", async () => {
    // The first variant narrates at once; the second waits for release().
    const second = deferredGenerate();
    let generateCalls = 0;
    const { callsFor, rerender } = renderWithTrpc(<NarrationHarness content={SKEWED_HTML} />, {
      handlers: {
        "narration.generate": () =>
          generateCalls++ === 0
            ? {
                narration: "One.\n\nTwo.\n\nThree.",
                cached: false,
                source: "llm",
                paragraphMap: [],
              }
            : second.handler(),
      },
      wrapper: (children) => <KeyboardShortcutsProvider>{children}</KeyboardShortcutsProvider>,
    });
    await startNarration();
    fireEvent.click(nextButton());
    expect(screen.getByText("2 of 3")).toBeInTheDocument();

    rerender(<NarrationHarness content={SKEWED_HTML} showFullContent={true} />);
    fireEvent.click(await screen.findByRole("button", { name: "Listen" }));
    await waitFor(() => expect(callsFor("narration.generate")).toHaveLength(2));

    expect(screen.getByRole("button", { name: "Generating..." })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Next paragraph" })).not.toBeInTheDocument();
    expect(screen.queryByText(/ of /)).not.toBeInTheDocument();

    await settle(second.release);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });
});
