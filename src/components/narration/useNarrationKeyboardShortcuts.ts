/**
 * useNarrationKeyboardShortcuts Hook
 *
 * Provides keyboard shortcuts for narration playback controls.
 * Should be used alongside the useNarration hook in article content views.
 *
 * Keyboard shortcuts:
 * - p: Toggle play/pause
 * - ]: Skip to next paragraph
 * - [: Skip to previous paragraph
 *
 * These shortcuts only work when:
 * - An article is open (narration controls are rendered)
 * - Narration is supported in the browser
 * - User is not typing in an input field, and no dialog is open
 */

"use client";

import { useKeyboardShortcutsContext } from "@/components/keyboard/KeyboardShortcutsProvider";
import { SHORTCUTS } from "@/components/keyboard/shortcuts";
import { useShortcutHotkeys } from "@/components/keyboard/useShortcutHotkeys";
import type { NarrationPhase } from "./useNarrationTypes";

// [ and ] need AltGr (or Option) on many non-US layouts, so modifiers are
// ignored when matching the produced character, but a Ctrl/Cmd chord without
// AltGr is someone else's shortcut.
const isBracketChord = (e: KeyboardEvent) =>
  e.metaKey || (e.ctrlKey && !e.getModifierState("AltGraph"));

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
 * // `narration` is the view NarrationEngine reports (it runs useNarration).
 * function NarrationControlsImpl({ narration }: { narration: UseNarrationReturn }) {
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
 *   // ...
 * }
 * ```
 */
export function useNarrationKeyboardShortcuts(options: UseNarrationKeyboardShortcutsOptions): void {
  const { phase, controls, isSupported } = options;
  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();

  const { isGenerating, shouldPause, canSkipForward, canSkipBackward } = phase;
  const { play, pause, skipForward, skipBackward } = controls;

  const baseEnabled = keyboardShortcutsEnabled && isSupported;

  // p - Toggle play/pause
  useShortcutHotkeys(
    SHORTCUTS.playPause.hotkey,
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
    },
    [shouldPause, isGenerating, play, pause, baseEnabled]
  );

  // ] - Skip to next paragraph
  useShortcutHotkeys(
    SHORTCUTS.nextParagraph.hotkey,
    (e) => {
      if (isBracketChord(e)) return;
      e.preventDefault();
      skipForward();
    },
    {
      enabled: baseEnabled && canSkipForward,
      useKey: true,
      ignoreModifiers: true,
    },
    [skipForward, canSkipForward, baseEnabled]
  );

  // [ - Skip to previous paragraph
  useShortcutHotkeys(
    SHORTCUTS.previousParagraph.hotkey,
    (e) => {
      if (isBracketChord(e)) return;
      e.preventDefault();
      skipBackward();
    },
    {
      enabled: baseEnabled && canSkipBackward,
      useKey: true,
      ignoreModifiers: true,
    },
    [skipBackward, canSkipBackward, baseEnabled]
  );
}
