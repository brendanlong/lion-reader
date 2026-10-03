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
import { useKeyboardShortcutsContext } from "@/components/keyboard/KeyboardShortcutsProvider";
import type { NarrationPhase } from "@/components/narration/useNarrationTypes";

/**
 * Narration control functions.
 */
interface NarrationShortcutControls {
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
  /** What the narration controls currently offer (`getNarrationPhase`) */
  phase: NarrationPhase;
  /** Narration control functions */
  controls: NarrationShortcutControls;
  /** Whether narration is supported in this browser */
  isSupported: boolean;
}

/**
 * Hook for narration keyboard shortcuts.
 *
 * Integrates with the existing keyboard shortcuts system and provides
 * playback controls via keyboard, offering exactly what the on-screen
 * controls offer.
 *
 * @param options - Narration phase and controls
 *
 * @example
 * ```tsx
 * function ArticleView() {
 *   const narration = useNarration({ id, type, title, feedTitle });
 *
 *   useNarrationKeyboardShortcuts({
 *     phase: getNarrationPhase(narration.state),
 *     controls: {
 *       play: narration.play,
 *       pause: narration.pause,
 *       skipForward: narration.skipForward,
 *       skipBackward: narration.skipBackward,
 *     },
 *     isSupported: narration.isSupported,
 *   });
 *
 *   return <NarrationControls {...} />;
 * }
 * ```
 */
export function useNarrationKeyboardShortcuts(options: UseNarrationKeyboardShortcutsOptions): void {
  const { phase, controls, isSupported } = options;
  const { enabled: keyboardShortcutsEnabled, isModalOpen } = useKeyboardShortcutsContext();

  const { isGenerating, shouldPause, canSkipForward, canSkipBackward } = phase;
  const { play, pause, skipForward, skipBackward } = controls;

  // Base enabled condition: shortcuts enabled, modal not open, narration supported
  const baseEnabled = keyboardShortcutsEnabled && !isModalOpen && isSupported;

  // p - Toggle play/pause
  useHotkeys(
    "p",
    (e) => {
      e.preventDefault();
      if (shouldPause) {
        pause();
      } else {
        play();
      }
    },
    {
      enabled: baseEnabled && !isGenerating,
      enableOnFormTags: false,
    },
    [shouldPause, isGenerating, play, pause, baseEnabled]
  );

  // Shift+N - Skip to next paragraph
  useHotkeys(
    "shift+n",
    (e) => {
      e.preventDefault();
      skipForward();
    },
    {
      enabled: baseEnabled && canSkipForward,
      enableOnFormTags: false,
    },
    [skipForward, canSkipForward, baseEnabled]
  );

  // Shift+P - Skip to previous paragraph
  useHotkeys(
    "shift+p",
    (e) => {
      e.preventDefault();
      skipBackward();
    },
    {
      enabled: baseEnabled && canSkipBackward,
      enableOnFormTags: false,
    },
    [skipBackward, canSkipBackward, baseEnabled]
  );
}
