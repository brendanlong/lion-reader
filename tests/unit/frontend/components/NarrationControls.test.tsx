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
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";
import { NarrationControlsImpl } from "@/components/narration/NarrationControls";
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
