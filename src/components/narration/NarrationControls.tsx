/**
 * NarrationControls Component
 *
 * Provides playback controls for article narration:
 * - Play/pause button
 * - Skip forward/backward buttons
 * - Current paragraph indicator
 * - Loading state
 *
 * Only renders if narration is supported in the current browser.
 *
 * NOTE: This component is loaded with next/dynamic ssr: false (see index.ts).
 * This avoids hydration mismatches since we can't check browser support on the server.
 *
 * Usage:
 * ```tsx
 * import { NarrationControls } from "@/components/narration";
 *
 * <NarrationControls narration={narration} />
 * ```
 */

"use client";

import type { UseNarrationReturn } from "./useNarrationTypes";
import { useNarrationKeyboardShortcuts } from "@/lib/hooks/useNarrationKeyboardShortcuts";
import { Button } from "@/components/ui/button";
import {
  PlayIcon,
  PauseIcon,
  SpinnerIcon,
  SkipBackwardIcon,
  SkipForwardIcon,
  NarrationIcon,
} from "@/components/ui/icons";

/**
 * Props for the NarrationControls component.
 */
export interface NarrationControlsProps {
  /**
   * The narration engine to drive. Owned by the parent because it also needs
   * the state for highlighting, and because a second `useNarration` would mean
   * a second speech engine for the same article.
   */
  narration: UseNarrationReturn;
}

/**
 * NarrationControls implementation.
 *
 * Exported for dynamic import in index.ts. Use the default export from
 * "@/components/narration" which wraps this with ssr: false.
 *
 * Renders playback controls for article narration. Only renders
 * if the Web Speech API is supported in the current browser.
 */
export function NarrationControlsImpl({ narration }: NarrationControlsProps) {
  const { state, isLoading, play, pause, skipForward, skipBackward, isSupported } = narration;

  // Enable keyboard shortcuts for narration (must be called before early return)
  useNarrationKeyboardShortcuts({
    state,
    controls: { play, pause, skipForward, skipBackward },
    isLoading,
    isSupported,
  });

  // Don't render if narration is not supported in this browser
  // This check is safe since we're loaded with ssr: false
  if (!isSupported) {
    return null;
  }

  // `currentNarrationParagraph`, not `currentParagraph`: the skip bounds and the
  // readout below are all relative to `totalParagraphs`, which counts narration
  // paragraphs, while `currentParagraph` is a DOM element index (see
  // `UseNarrationState`).
  const { status, currentNarrationParagraph, totalParagraphs } = state;
  const isPlaying = status === "playing";
  const isPaused = status === "paused";
  // "loading" once we already have paragraphs means we're generating the next
  // chunk mid-playback. The controls stay live here so the user can pause or
  // skip while a chunk generates. Before any paragraphs exist we're still doing
  // the initial narration generation, where there's nothing yet to control.
  const isBufferingMidPlayback = status === "loading" && totalParagraphs > 0;
  const isInitialLoading = (isLoading || status === "loading") && !isBufferingMidPlayback;
  const isActive = isPlaying || isPaused || isBufferingMidPlayback;

  /**
   * Handle play/pause button click. Pausing works while a chunk is generating
   * (buffering) as well as during normal playback.
   */
  const handlePlayPause = () => {
    if (isPlaying || isBufferingMidPlayback) {
      pause();
    } else {
      play();
    }
  };

  // Determine the main button label and icon
  let mainButtonLabel: string;
  let mainButtonIcon: React.ReactNode;

  if (isInitialLoading) {
    mainButtonLabel = "Generating...";
    mainButtonIcon = <SpinnerIcon className="h-5 w-5" />;
  } else if (isBufferingMidPlayback) {
    // A chunk is generating, but playback is active — keep the spinner as an
    // activity indicator while letting the button pause.
    mainButtonLabel = "Pause";
    mainButtonIcon = <SpinnerIcon className="h-5 w-5" />;
  } else if (isPlaying) {
    mainButtonLabel = "Pause";
    mainButtonIcon = <PauseIcon className="h-5 w-5" />;
  } else if (isPaused) {
    mainButtonLabel = "Resume";
    mainButtonIcon = <PlayIcon className="h-5 w-5" />;
  } else {
    mainButtonLabel = "Listen";
    mainButtonIcon = <NarrationIcon />;
  }

  return (
    <div className="flex items-center gap-2">
      {/* Skip backward button - only show when active */}
      {isActive && (
        <Button
          variant="ghost"
          size="sm"
          onClick={skipBackward}
          disabled={currentNarrationParagraph === 0}
          aria-label="Previous paragraph"
          className="min-w-[36px] px-2"
        >
          <SkipBackwardIcon />
        </Button>
      )}

      {/* Main play/pause button */}
      <Button
        variant="secondary"
        size="sm"
        onClick={handlePlayPause}
        disabled={isInitialLoading}
        aria-label={mainButtonLabel}
      >
        {mainButtonIcon}
        <span className="ml-2">{mainButtonLabel}</span>
      </Button>

      {/* Skip forward button - only show when active */}
      {isActive && (
        <Button
          variant="ghost"
          size="sm"
          onClick={skipForward}
          disabled={currentNarrationParagraph >= totalParagraphs - 1}
          aria-label="Next paragraph"
          className="min-w-[36px] px-2"
        >
          <SkipForwardIcon />
        </Button>
      )}

      {/* Paragraph indicator - only show when active */}
      {isActive && totalParagraphs > 0 && (
        <span className="ui-text-xs text-muted tabular-nums">
          {currentNarrationParagraph + 1} of {totalParagraphs}
        </span>
      )}
    </div>
  );
}
