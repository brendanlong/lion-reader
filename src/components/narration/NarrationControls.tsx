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
 * <NarrationControls
 *   articleId="..."
 *   title="Article Title"
 *   feedTitle="Feed Name"
 * />
 * ```
 */

"use client";

import { useNarration } from "./useNarration";
import { useNarrationKeyboardShortcuts } from "@/lib/hooks/useNarrationKeyboardShortcuts";
import { Button } from "@/components/ui/button";
import {
  PlayIcon,
  PauseIcon,
  SpinnerIcon,
  SkipBackwardIcon,
  SkipForwardIcon,
  NarrationIcon,
} from "@/components/ui/icon-button";

/**
 * Props for the NarrationControls component.
 */
export interface NarrationControlsProps {
  /** The article ID (entry or saved article) */
  articleId: string;
  /** Title of the article (for Media Session) */
  title: string;
  /** Feed or site name (for Media Session) */
  feedTitle: string;
  /** Optional artwork URL for Media Session */
  artwork?: string;
  /**
   * Optional HTML content for client-side processing.
   * Used in uncontrolled mode when LLM normalization is disabled.
   */
  content?: string | null;
  /**
   * Optional external narration state for controlled mode.
   * When provided, the component won't create its own useNarration hook.
   * This is used when the parent needs access to narration state (e.g., for highlighting).
   */
  narration?: ReturnType<typeof useNarration>;
}

/**
 * NarrationControls implementation.
 *
 * Exported for dynamic import in index.ts. Use the default export from
 * "@/components/narration" which wraps this with ssr: false.
 *
 * Renders playback controls for article narration. Only renders
 * if the Web Speech API is supported in the current browser.
 *
 * Can be used in two modes:
 * 1. Uncontrolled: Component manages its own narration state
 * 2. Controlled: Parent provides narration state via the `narration` prop
 *    (used when parent needs access to state for highlighting)
 */
export function NarrationControlsImpl({
  articleId,
  title,
  feedTitle,
  artwork,
  content,
  narration: externalNarration,
}: NarrationControlsProps) {
  // Use internal narration hook only when external state is not provided
  const internalNarration = useNarration({
    id: articleId,
    title,
    feedTitle,
    artwork,
    content,
  });

  // Use external narration if provided, otherwise use internal
  const { state, isLoading, play, pause, skipForward, skipBackward, isSupported } =
    externalNarration ?? internalNarration;

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

  const { status, currentParagraph, totalParagraphs } = state;
  const isPlaying = status === "playing";
  const isPaused = status === "paused";
  // Consider "loading" as active when we already have paragraphs (buffering mid-playback)
  // vs initial generation (no paragraphs yet)
  const isBufferingMidPlayback = status === "loading" && totalParagraphs > 0;
  const isActive = isPlaying || isPaused || isBufferingMidPlayback;

  /**
   * Handle play/pause button click.
   */
  const handlePlayPause = () => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  };

  // Determine the main button label and icon
  let mainButtonLabel: string;
  let mainButtonIcon: React.ReactNode;

  // Show loading state for both initial generation and mid-playback buffering
  const showLoadingState = isLoading || isBufferingMidPlayback;

  if (showLoadingState) {
    mainButtonLabel = "Generating...";
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
          disabled={showLoadingState || currentParagraph === 0}
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
        disabled={showLoadingState}
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
          disabled={showLoadingState || currentParagraph >= totalParagraphs - 1}
          aria-label="Next paragraph"
          className="min-w-[36px] px-2"
        >
          <SkipForwardIcon />
        </Button>
      )}

      {/* Paragraph indicator - only show when active */}
      {isActive && totalParagraphs > 0 && (
        <span className="ui-text-xs text-zinc-500 dark:text-zinc-400">
          {currentParagraph + 1} of {totalParagraphs}
        </span>
      )}
    </div>
  );
}
