/**
 * Compact narration transport for the reader's floating bar (see
 * StickyEntryControls), so an article being listened to stays controllable
 * after the full NarrationControls scroll out of view. Renders only while
 * narration is active; keyboard shortcuts stay owned by NarrationControls.
 */

"use client";

import { getNarrationPhase, type UseNarrationReturn } from "./useNarrationTypes";
import {
  PlayIcon,
  PauseIcon,
  SpinnerIcon,
  SkipBackwardIcon,
  SkipForwardIcon,
} from "@/components/ui/icons";

const buttonClass =
  "text-muted hover:bg-surface-muted flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full transition-colors disabled:opacity-40 disabled:hover:bg-transparent";

export function FloatingNarrationControls({ narration }: { narration: UseNarrationReturn }) {
  const { state, play, pause, skipForward, skipBackward, isSupported } = narration;
  const { isPlaying, isBuffering, isActive, shouldPause, canSkipBackward, canSkipForward } =
    getNarrationPhase(state);

  if (!isSupported || !isActive) return null;

  return (
    <>
      <div className="bg-fill-muted h-5 w-px" />

      <button
        onClick={skipBackward}
        disabled={!canSkipBackward}
        className={buttonClass}
        aria-label="Previous paragraph"
      >
        <SkipBackwardIcon />
      </button>

      <button
        onClick={shouldPause ? pause : play}
        className={`${buttonClass} text-body`}
        aria-label={shouldPause ? "Pause" : "Resume"}
      >
        {isBuffering ? (
          <SpinnerIcon className="h-5 w-5" />
        ) : isPlaying ? (
          <PauseIcon className="h-5 w-5" />
        ) : (
          <PlayIcon className="h-5 w-5" />
        )}
      </button>

      <button
        onClick={skipForward}
        disabled={!canSkipForward}
        className={buttonClass}
        aria-label="Next paragraph"
      >
        <SkipForwardIcon />
      </button>

      <span
        className="ui-text-xs text-muted pr-1 tabular-nums"
        title="Click a paragraph to narrate from there"
      >
        {state.currentNarrationParagraph + 1}/{state.totalParagraphs}
      </span>
    </>
  );
}
