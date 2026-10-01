/**
 * Narration in the native app's reader view: bundled into the app's reader
 * assets by `scripts/export-app-narration.ts` (`pnpm app:narration`) and run in
 * its WebView, so the app speaks, numbers and highlights an article with the
 * web's own walk over the browser's own parse of it, the way
 * `htmlToClientNarration` does on the web.
 *
 * Talks to the app over its `lionReader` message channel: it sends the
 * article's narration once (`{type: "narration"}`) and the paragraph the user
 * tapped (`{type: "seek"}`), and the app calls `lionNarration.highlight` and
 * `lionNarration.selectedParagraph` (for "Listen" on a selection).
 *
 * @module narration/app-reader
 */

import { narrationTargets } from "./block-elements";
import {
  buildAlignedNarration,
  narrationParagraphForElement,
  splitNarrationParagraphs,
  type ParagraphMapEntry,
} from "./paragraph-map";
import { DIRECT_TTS_VOICE, narrationRuns } from "./runs";
import { narrationElementIndex, seekTargetElement } from "./seek-target";

interface AppChannel {
  postMessage(message: string): void;
}

declare global {
  interface Window {
    lionReader?: AppChannel;
    lionNarration?: {
      highlight(paragraph: number | null, scroll: boolean): void;
      selectedParagraph(): number | null;
    };
  }
}

const HIGHLIGHT_CLASS = "lr-narrating";

/**
 * Numbers the article's elements and builds its narration. The app's header and
 * summary come first in `<body>`; set aside while this runs, what's left parses
 * exactly like the web's `<body>${html}</body>`, so the numbering matches. (The
 * summary is a balanced fragment — the server closes its tags — so the article
 * can't end up inside it.)
 */
function prepare(): ParagraphMapEntry[] {
  const chrome = Array.from(
    document.body.querySelectorAll(":scope > .lr-header, :scope > .lr-summary")
  );
  chrome.forEach((el) => el.remove());
  try {
    narrationTargets(document.body).forEach((el, index) =>
      el.setAttribute("data-para-id", `para-${index}`)
    );
    const { narrationText, paragraphMap } = buildAlignedNarration(
      narrationRuns(document.body, DIRECT_TTS_VOICE)
    );
    window.lionReader?.postMessage(
      JSON.stringify({
        type: "narration",
        paragraphs: splitNarrationParagraphs(narrationText),
      })
    );
    return paragraphMap;
  } finally {
    document.body.prepend(...chrome);
  }
}

const paragraphMap = prepare();

window.lionNarration = {
  highlight(paragraph, scroll) {
    document
      .querySelectorAll(`.${HIGHLIGHT_CLASS}`)
      .forEach((el) => el.classList.remove(HIGHLIGHT_CLASS));
    const element = paragraph === null ? undefined : paragraphMap[paragraph]?.o;
    if (element === undefined || element < 0) return;
    const target = document.querySelector(`[data-para-id="para-${element}"]`);
    if (!target) return;
    target.classList.add(HIGHLIGHT_CLASS);
    if (!scroll) return;
    const box = target.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  },

  /**
   * The paragraph the selection starts in; starting outside the article's text
   * (Select all, the summary, between elements), the first one it covers.
   */
  selectedParagraph() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const container = range.startContainer;
    const start =
      container instanceof Element
        ? (container.childNodes[range.startOffset] ?? container)
        : container;
    const startElement = start instanceof Element ? start : start.parentElement;
    const element =
      narrationElementIndex(startElement?.closest("[data-para-id]")) ??
      narrationElementIndex(
        Array.from(document.querySelectorAll("[data-para-id]")).find((el) =>
          range.intersectsNode(el)
        )
      );
    return element === null ? null : narrationParagraphForElement(paragraphMap, element);
  },
};

// Tapping a paragraph starts narration there (the app ignores it unless this
// article is being narrated), with the web's rules for what's a seek.
let hadSelectionAtPointerDown = false;
document.addEventListener(
  "pointerdown",
  () => {
    hadSelectionAtPointerDown = window.getSelection()?.isCollapsed === false;
  },
  true
);
document.addEventListener("click", (event) => {
  const element = seekTargetElement(event, hadSelectionAtPointerDown);
  const paragraph = element === null ? null : narrationParagraphForElement(paragraphMap, element);
  if (paragraph !== null) {
    window.lionReader?.postMessage(JSON.stringify({ type: "seek", paragraph }));
  }
});
