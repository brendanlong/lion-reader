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
 * Usage:
 * ```tsx
 * <NarrationControls
 *   articleId="..."
 *   title="Article Title"
 *   feedTitle="Feed Name"
 * />
 * ```
 */

"use client";

import { useNarration } from "./useNarration";
import { isNarrationSupported } from "@/lib/narration/feature-detection";
import { useNarrationKeyboardShortcuts } from "@/lib/hooks/useNarrationKeyboardShortcuts";
import { Button } from "@/components/ui/button";

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
 * Play icon for the play button.
 */
function PlayIcon() {
  return (
    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

/**
 * Pause icon for the pause button.
 */
function PauseIcon() {
  return (
    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
    </svg>
  );
}

/**
 * Skip backward icon.
 */
function SkipBackwardIcon() {
  return (
    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z" />
    </svg>
  );
}

/**
 * Skip forward icon.
 */
function SkipForwardIcon() {
  return (
    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 6h2v12h-2V6zm-10 0l8.5 6L6 18V6z" />
    </svg>
  );
}

/**
 * Loading spinner icon.
 */
function LoadingSpinner() {
  return (
    <svg
      className="h-5 w-5 animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

/**
 * Audio/narration icon for the button label.
 */
function NarrationIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
      />
    </svg>
  );
}

/**
 * NarrationControls component.
 *
 * Renders playback controls for article narration. Only renders
 * if the Web Speech API is supported in the current browser.
 *
 * Can be used in two modes:
 * 1. Uncontrolled: Component manages its own narration state
 * 2. Controlled: Parent provides narration state via the `narration` prop
 *    (used when parent needs access to state for highlighting)
 */
export function NarrationControls({
  articleId,
  title,
  feedTitle,
  artwork,
  content,
  narration,
}: NarrationControlsProps) {
  // Don't render if narration is not supported
  if (!isNarrationSupported()) {
    return null;
  }

  return (
    <NarrationControlsInner
      articleId={articleId}
      title={title}
      feedTitle={feedTitle}
      artwork={artwork}
      content={content}
      narration={narration}
    />
  );
}

/**
 * Inner component that uses the narration hook.
 * Separated to avoid calling hooks conditionally.
 */
function NarrationControlsInner({
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

  // Enable keyboard shortcuts for narration
  useNarrationKeyboardShortcuts({
    state,
    controls: { play, pause, skipForward, skipBackward },
    isLoading,
    isSupported,
  });

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
    mainButtonIcon = <LoadingSpinner />;
  } else if (isPlaying) {
    mainButtonLabel = "Pause";
    mainButtonIcon = <PauseIcon />;
  } else if (isPaused) {
    mainButtonLabel = "Resume";
    mainButtonIcon = <PlayIcon />;
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
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {currentParagraph + 1} of {totalParagraphs}
        </span>
      )}
    </div>
  );
}
