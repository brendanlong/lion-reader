/**
 * Narration for the entry reader: the lazily loaded engine, its controls,
 * paragraph highlighting, click-to-seek and auto-scroll, behind one hook so
 * the reader places the pieces without knowing how narration works.
 */

"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { NarrationControls, NarrationEngine } from "./index";
import { FloatingNarrationControls } from "./FloatingNarrationControls";
import { NarrationHighlightStyles } from "./NarrationHighlightStyles";
import {
  DEFAULT_NARRATION_STATE,
  getNarrationPhase,
  type NarrationEngineView,
} from "./useNarrationTypes";
import { useNarrationHighlight } from "./useNarrationHighlight";
import { useNarrationSettings } from "@/lib/narration/settings";
import { seekTargetElement } from "@/lib/narration/seek-target";
import { NEXT_ARTICLE, NO_MORE_ARTICLES } from "@/lib/narration/paragraph-map";
import {
  clearNarrationContinuation,
  continueNarrationTo,
  narrationContinuesTo,
} from "./continuation";
import type { PrerecordedVoice } from "@/lib/narration/prerecorded-speech";

interface UseEntryNarrationOptions {
  /** The element the article body renders into. */
  contentRef: RefObject<HTMLDivElement | null>;
  articleId: string;
  title: string;
  feedTitle: string;
  /** The content variant on screen (`selectDisplayedContent`). */
  content: string | null;
  /**
   * The current view state, so the server narrates (and maps highlights
   * against) exactly the variant on screen, not a fixed
   * full/cleaned/original priority.
   */
  showFullContent: boolean;
  showOriginal: boolean;
  prerecordedVoice?: PrerecordedVoice;
  /** Narration went on to this article and should play once it's ready. */
  continued?: boolean;
  /** The next article in the list, and opening it; absent at its end. */
  next?: { id: string; open: () => void };
}

interface EntryNarration {
  /** Renders nothing visible; mount it anywhere. */
  engine: ReactNode;
  /** The HTML to render: `content`, with paragraph ids while highlighting. */
  contentHtml: string | null;
  onContentClick: React.MouseEventHandler;
  /** For the action bar. */
  controls: ReactNode;
  /** Goes before the article body. */
  highlightStyles: ReactNode;
  /** For the sticky controls, once the engine has loaded. */
  floatingControls: ReactNode;
}

/**
 * Whether narration went on to `articleId` from the article before: for the
 * entry view to call as it opens, before its content loads, so closing it
 * first drops the continuation rather than leaving it for a later opening.
 */
export function useNarrationContinuedHere(articleId: string): boolean {
  const [continued] = useState(() => narrationContinuesTo(articleId));
  useEffect(() => clearNarrationContinuation(), []);
  return continued;
}

export function useEntryNarration({
  contentRef,
  articleId,
  title,
  feedTitle,
  content,
  showFullContent,
  showOriginal,
  prerecordedVoice,
  continued = false,
  next,
}: UseEntryNarrationOptions): EntryNarration {
  const [narrationSettings] = useNarrationSettings();
  const showNarration = narrationSettings.enabled;

  // The engine loads lazily and reports its state here. It's only mounted while
  // narration is enabled, so disabling narration mid-playback stops it.
  const [narrationEngine, setNarrationEngine] = useState<NarrationEngineView | null>(null);
  const narration = showNarration ? narrationEngine : null;
  const narrationState = narration?.state ?? DEFAULT_NARRATION_STATE;
  const isNarrationActive = getNarrationPhase(narrationState).isActive;

  const continuing = narrationSettings.continueToNextArticle;
  const following = continuing ? (next ? NEXT_ARTICLE : NO_MORE_ARTICLES) : undefined;
  const goOn = useCallback(() => {
    if (!continuing || !next) return;
    continueNarrationTo(next.id);
    next.open();
  }, [continuing, next]);

  // Narration that went on to this article plays once its engine is ready, and
  // passes over it if there's nothing to say.
  const play = narration?.play;
  const isSupported = narration?.isSupported ?? false;
  const startedRef = useRef(false);
  useEffect(() => {
    if (!continued || !play || !isSupported || startedRef.current) return;
    startedRef.current = true;
    play();
  }, [continued, play, isSupported]);
  const onNothingToSay = useCallback(() => {
    if (continued) goOn();
  }, [continued, goOn]);

  const { highlightedParagraphIds } = useNarrationHighlight({
    currentParagraphIndex: narrationState.currentParagraph,
    isActive: isNarrationActive,
  });

  // While narration is active, clicking a paragraph narrates from there (a
  // paused narration moves there and stays paused). Clicks
  // that mean something else — following a link, finishing a text selection —
  // are left alone.
  const playFromElement = narration?.playFromElement;
  // The press that dismisses a selection collapses it before `click` fires, so
  // whether one existed has to be captured on the way down.
  const hadSelectionAtPointerDownRef = useRef(false);
  useEffect(() => {
    if (!showNarration || !isNarrationActive) return;
    const recordSelection = () => {
      hadSelectionAtPointerDownRef.current = window.getSelection()?.isCollapsed === false;
    };
    document.addEventListener("pointerdown", recordSelection, true);
    return () => document.removeEventListener("pointerdown", recordSelection, true);
  }, [showNarration, isNarrationActive]);

  const onContentClick = useCallback(
    (event: React.MouseEvent) => {
      if (!playFromElement || !isNarrationActive) return;
      const elementIndex = seekTargetElement(event, hadSelectionAtPointerDownRef.current);
      if (elementIndex !== null) playFromElement(elementIndex);
    },
    [isNarrationActive, playFromElement]
  );

  const shouldProcessForHighlighting = narration?.isHighlighting ?? false;
  const highlightHtml = narration?.highlightSource === content ? narration.highlightHtml : null;
  const contentHtml = content ? (highlightHtml ?? content) : null;

  // Auto-scroll to the highlighted paragraph while playing. The highlight
  // itself is CSS (NarrationHighlightStyles), not DOM manipulation.
  useEffect(() => {
    if (!contentRef.current || !shouldProcessForHighlighting) return;
    if (!narrationSettings.autoScrollEnabled) return;
    if (narrationState.status !== "playing") return;
    if (highlightedParagraphIds.size === 0) return;

    // Find the first highlighted element for scrolling
    const container = contentRef.current;
    const firstIndex = Math.min(...highlightedParagraphIds);
    const element = container.querySelector(
      `[data-para-id="para-${firstIndex}"]`
    ) as HTMLElement | null;

    if (!element) return;

    // Check if element is already in viewport
    const rect = element.getBoundingClientRect();
    // Account for the header (scroll-margin-top is 100px in CSS)
    const headerHeight = 100;
    const isInViewport = rect.top >= headerHeight && rect.bottom <= window.innerHeight;

    if (!isInViewport) {
      element.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [
    contentRef,
    highlightedParagraphIds,
    shouldProcessForHighlighting,
    narrationSettings.autoScrollEnabled,
    narrationState.status,
  ]);

  return {
    engine: showNarration && (
      <NarrationEngine
        id={articleId}
        title={title}
        feedTitle={feedTitle}
        content={content}
        showFullContent={showFullContent}
        showOriginal={showOriginal}
        prerecordedVoice={prerecordedVoice}
        following={following}
        onFinished={goOn}
        onNothingToSay={onNothingToSay}
        onChange={setNarrationEngine}
      />
    ),
    contentHtml,
    onContentClick,
    controls: showNarration && <NarrationControls narration={narration} />,
    highlightStyles: showNarration && shouldProcessForHighlighting && (
      <NarrationHighlightStyles
        highlightedParagraphIds={highlightedParagraphIds}
        enabled={narrationSettings.highlightEnabled}
        seekable={isNarrationActive}
      />
    ),
    floatingControls: narration ? <FloatingNarrationControls narration={narration} /> : undefined,
  };
}
