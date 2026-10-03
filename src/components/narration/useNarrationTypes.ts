/**
 * Narration Hook Types and Helpers
 *
 * Shared types, interfaces, and utility functions used by the narration hooks.
 */

import type { NarrationState } from "@/lib/narration/ArticleNarrator";
import type { NarrationStatus } from "@/lib/narration/types";

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for the useNarration hook.
 */
export interface UseNarrationConfig {
  /** The article ID (entry or saved article) */
  id: string;
  /** Title of the article (for Media Session) */
  title: string;
  /** Feed or site name (for Media Session) */
  feedTitle: string;
  /** Optional artwork URL for Media Session */
  artwork?: string;
  /**
   * Optional HTML content for client-side processing.
   * When provided and LLM normalization is disabled, narration will be
   * generated client-side without a server call.
   */
  content?: string | null;
  /**
   * Which content variant is currently on screen. Forwarded to the server so
   * LLM narration reads (and highlights against) the same variant the user
   * sees. Defaults to false/false (cleaned feed content) when omitted.
   */
  showFullContent?: boolean;
  showOriginal?: boolean;
}

/**
 * The state `useNarration` exposes, which spans **two index spaces**.
 *
 * The player (`ArticleNarrator` or `MediaSourcePlayer`) counts *narration
 * paragraphs* — the segments `splitNarrationParagraphs` produces — while highlighting
 * needs the *DOM element* the current segment came from. The paragraph map
 * translates one to the other, and it is not the identity: one element can
 * narrate as several paragraphs and an element can narrate as none (see
 * `@/lib/narration/paragraph-map`).
 *
 * So `currentParagraph` is a DOM element index and `currentNarrationParagraph`
 * is the untranslated player index. `totalParagraphs` is a count of *narration*
 * paragraphs, so anything comparing a position against it (skip bounds, the
 * "X of Y" readout) must use `currentNarrationParagraph`; only highlighting uses
 * `currentParagraph`.
 */
export interface UseNarrationState extends Omit<NarrationState, "status"> {
  status: NarrationStatus;
  /** Index of the current paragraph in the player's own (narration) space. */
  currentNarrationParagraph: number;
}

/**
 * Return type for the useNarration hook.
 */
export interface UseNarrationReturn {
  /** Current narration state */
  state: UseNarrationState;
  /** Start or resume playback */
  play: () => void;
  /** Pause playback */
  pause: () => void;
  /** Skip to the next paragraph */
  skipForward: () => void;
  /** Skip to the previous paragraph */
  skipBackward: () => void;
  /**
   * Play from the narration paragraph for DOM element `para-{elementIndex}`
   * (or the next narrated one after it)
   */
  playFromElement: (elementIndex: number) => void;
  /** Stop playback and reset to beginning */
  stop: () => void;
  /** Whether narration is supported in this browser */
  isSupported: boolean;
  /** Processed HTML with data-para-id attributes (only for client-side narration) */
  processedHtml: string | null;
}

// ============================================================================
// Default State
// ============================================================================

/**
 * Default narration state when no article is loaded.
 */
export const DEFAULT_NARRATION_STATE: UseNarrationState & { status: "idle" } = {
  status: "idle",
  currentParagraph: 0,
  currentNarrationParagraph: 0,
  totalParagraphs: 0,
  selectedVoice: null,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Which controls the narration UI should offer for the current state.
 *
 * Positions compare `currentNarrationParagraph`, not `currentParagraph`: skip
 * bounds and the "X of Y" readout are relative to `totalParagraphs`, which
 * counts narration paragraphs (see `UseNarrationState`).
 */
export function getNarrationPhase(state: UseNarrationState) {
  const { status, currentNarrationParagraph, totalParagraphs } = state;
  const isPlaying = status === "playing";
  const isPaused = status === "paused";
  // Buffering keeps the controls live so the user can pause or skip while a
  // chunk synthesizes; generating has nothing to control yet.
  const isBuffering = status === "buffering";
  const isActive = isPlaying || isPaused || isBuffering;
  return {
    isPlaying,
    isPaused,
    isBuffering,
    isGenerating: status === "generating",
    isActive,
    /** Whether the play/pause toggle should pause (it pauses while buffering too) */
    shouldPause: isPlaying || isBuffering,
    canSkipBackward: isActive && currentNarrationParagraph > 0,
    canSkipForward: isActive && currentNarrationParagraph < totalParagraphs - 1,
  };
}

export type NarrationPhase = ReturnType<typeof getNarrationPhase>;
