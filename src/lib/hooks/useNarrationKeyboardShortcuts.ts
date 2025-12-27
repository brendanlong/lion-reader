/**
 * useNarrationKeyboardShortcuts Hook
 *
 * Provides keyboard shortcuts for narration playback controls.
 * Should be used alongside the useNarration hook in article content views.
 *
 * Keyboard shortcuts:
 * - p: Toggle play/pause
 * - Shift+N: Skip to next paragraph
 * - Shift+P: Skip to previous paragraph
 *
 * These shortcuts only work when:
 * - An article is open (narration controls are rendered)
 * - Narration is supported in the browser
 * - User is not typing in an input field
 */

"use client";

import { useHotkeys } from "react-hotkeys-hook";
import { useKeyboardShortcutsContext } from "@/components/keyboard";

/**
 * Narration state for determining shortcut behavior.
 */
export interface NarrationShortcutState {
  /** Current playback status */
  status: "idle" | "loading" | "playing" | "paused";
  /** Current paragraph index (0-based) */
  currentParagraph: number;
  /** Total number of paragraphs */
  totalParagraphs: number;
}

/**
 * Narration control functions.
 */
export interface NarrationShortcutControls {
  /** Start or resume playback */
  play: () => void;
  /** Pause playback */
  pause: () => void;
  /** Skip to the next paragraph */
  skipForward: () => void;
  /** Skip to the previous paragraph */
  skipBackward: () => void;
}

/**
 * Configuration options for narration keyboard shortcuts.
 */
export interface UseNarrationKeyboardShortcutsOptions {
  /** Current narration state */
  state: NarrationShortcutState;
  /** Narration control functions */
  controls: NarrationShortcutControls;
  /** Whether narration is loading */
  isLoading: boolean;
  /** Whether narration is supported in this browser */
  isSupported: boolean;
}

/**
 * Hook for narration keyboard shortcuts.
 *
 * Integrates with the existing keyboard shortcuts system and provides
 * playback controls via keyboard.
 *
 * @param options - Narration state and controls
 *
 * @example
 * ```tsx
 * function ArticleView() {
 *   const narration = useNarration({ id, type, title, feedTitle });
 *
 *   useNarrationKeyboardShortcuts({
 *     state: narration.state,
 *     controls: {
 *       play: narration.play,
 *       pause: narration.pause,
 *       skipForward: narration.skipForward,
 *       skipBackward: narration.skipBackward,
 *     },
 *     isLoading: narration.isLoading,
 *     isSupported: narration.isSupported,
 *   });
 *
 *   return <NarrationControls {...} />;
 * }
 * ```
 */
export function useNarrationKeyboardShortcuts(options: UseNarrationKeyboardShortcutsOptions): void {
  const { state, controls, isLoading, isSupported } = options;
  const { enabled: keyboardShortcutsEnabled, isModalOpen } = useKeyboardShortcutsContext();

  const { status, currentParagraph, totalParagraphs } = state;
  const { play, pause, skipForward, skipBackward } = controls;

  const isPlaying = status === "playing";
  const isPaused = status === "paused";

  // Base enabled condition: shortcuts enabled, modal not open, narration supported
  const baseEnabled = keyboardShortcutsEnabled && !isModalOpen && isSupported;

  // p - Toggle play/pause
  useHotkeys(
    "p",
    (e) => {
      e.preventDefault();
      if (isPlaying) {
        pause();
      } else {
        play();
      }
    },
    {
      enabled: baseEnabled && !isLoading,
      enableOnFormTags: false,
    },
    [isPlaying, isLoading, play, pause, baseEnabled]
  );

  // Shift+N - Skip to next paragraph
  useHotkeys(
    "shift+n",
    (e) => {
      e.preventDefault();
      skipForward();
    },
    {
      enabled:
        baseEnabled &&
        !isLoading &&
        (isPlaying || isPaused) &&
        currentParagraph < totalParagraphs - 1,
      enableOnFormTags: false,
    },
    [skipForward, isLoading, isPlaying, isPaused, currentParagraph, totalParagraphs, baseEnabled]
  );

  // Shift+P - Skip to previous paragraph
  useHotkeys(
    "shift+p",
    (e) => {
      e.preventDefault();
      skipBackward();
    },
    {
      enabled: baseEnabled && !isLoading && (isPlaying || isPaused) && currentParagraph > 0,
      enableOnFormTags: false,
    },
    [skipBackward, isLoading, isPlaying, isPaused, currentParagraph, baseEnabled]
  );
}
