/**
 * Narration Hook Types and Helpers
 *
 * Shared types, interfaces, and utility functions used by the narration hooks.
 */

import type { NarrationState } from "@/lib/narration/ArticleNarrator";
import type { PlaybackStatus } from "@/lib/narration/streaming-audio-player";

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
}

/**
 * Return type for the useNarration hook.
 */
export interface UseNarrationReturn {
  /** Current narration state */
  state: NarrationState;
  /** Whether narration text is being generated */
  isLoading: boolean;
  /** Start or resume playback */
  play: () => void;
  /** Pause playback */
  pause: () => void;
  /** Skip to the next paragraph */
  skipForward: () => void;
  /** Skip to the previous paragraph */
  skipBackward: () => void;
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
export const DEFAULT_NARRATION_STATE: NarrationState = {
  status: "idle",
  currentParagraph: 0,
  totalParagraphs: 0,
  selectedVoice: null,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Splits narration text into paragraphs.
 */
export function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Maps StreamingAudioPlayer status to NarrationState status.
 */
export function mapPlaybackStatus(status: PlaybackStatus): NarrationState["status"] {
  switch (status) {
    case "playing":
      return "playing";
    case "paused":
      return "paused";
    case "buffering":
      return "loading";
    case "idle":
    default:
      return "idle";
  }
}
