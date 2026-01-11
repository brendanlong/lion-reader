/**
 * Media Session API Integration for Lion Reader's Narration Feature
 *
 * Enables OS-level playback controls:
 * - Lock screen controls (iOS/Android)
 * - Keyboard media keys (play/pause, prev/next)
 * - Headphone buttons
 * - Notification center media controls
 *
 * Usage:
 * ```typescript
 * import { setupMediaSession, clearMediaSession } from "@/lib/narration/media-session";
 *
 * // When starting narration
 * setupMediaSession({
 *   articleTitle: "Article Title",
 *   feedTitle: "Feed Name",
 *   narrator: articleNarrator,
 *   artwork: "https://example.com/icon.png" // optional
 * });
 *
 * // When leaving the article
 * clearMediaSession();
 * ```
 */

import { isMediaSessionSupported } from "./feature-detection";
import type { ArticleNarrator } from "./ArticleNarrator";

/**
 * Options for setting up the media session.
 */
export interface MediaSessionOptions {
  /** Title of the article being narrated */
  articleTitle: string;
  /** Name of the feed the article is from */
  feedTitle: string;
  /** The ArticleNarrator instance to control */
  narrator: ArticleNarrator;
  /** Optional URL to artwork/icon to display in media controls */
  artwork?: string;
}

/**
 * Playback state for the media session.
 */
type MediaSessionPlaybackState = "playing" | "paused" | "none";

/**
 * Sets up the Media Session API for OS-level playback controls.
 *
 * This function:
 * - Sets metadata (title, artist, album, artwork)
 * - Registers action handlers (play, pause, stop, prev, next)
 * - Enables lock screen and keyboard media key controls
 *
 * If the Media Session API is not supported, this function does nothing
 * (graceful degradation).
 *
 * @param options - Configuration for the media session
 *
 * @example
 * ```typescript
 * const narrator = new ArticleNarrator();
 * narrator.loadArticle("...");
 *
 * setupMediaSession({
 *   articleTitle: "How to Build a Feed Reader",
 *   feedTitle: "Tech Blog",
 *   narrator,
 * });
 *
 * narrator.play();
 * updateMediaSessionState("playing");
 * ```
 */
export function setupMediaSession(options: MediaSessionOptions): void {
  if (!isMediaSessionSupported()) {
    return;
  }

  const { articleTitle, feedTitle, narrator, artwork } = options;

  // Set up metadata for the media session
  const artworkArray: MediaImage[] = artwork
    ? [
        { src: artwork, sizes: "96x96", type: "image/png" },
        { src: artwork, sizes: "128x128", type: "image/png" },
        { src: artwork, sizes: "192x192", type: "image/png" },
        { src: artwork, sizes: "256x256", type: "image/png" },
        { src: artwork, sizes: "384x384", type: "image/png" },
        { src: artwork, sizes: "512x512", type: "image/png" },
      ]
    : [];

  navigator.mediaSession.metadata = new MediaMetadata({
    title: articleTitle,
    artist: feedTitle,
    album: "Lion Reader",
    artwork: artworkArray,
  });

  // Register action handlers
  // Play: Resume narration
  navigator.mediaSession.setActionHandler("play", () => {
    narrator.resume();
    updateMediaSessionState("playing");
  });

  // Pause: Pause narration
  navigator.mediaSession.setActionHandler("pause", () => {
    narrator.pause();
    updateMediaSessionState("paused");
  });

  // Stop: Stop narration completely
  navigator.mediaSession.setActionHandler("stop", () => {
    narrator.stop();
    updateMediaSessionState("none");
  });

  // Previous track: Skip to previous paragraph
  navigator.mediaSession.setActionHandler("previoustrack", () => {
    narrator.skipBackward();
  });

  // Next track: Skip to next paragraph
  navigator.mediaSession.setActionHandler("nexttrack", () => {
    narrator.skipForward();
  });

  // Initialize playback state
  navigator.mediaSession.playbackState = "none";
}

/**
 * Updates the media session playback state.
 *
 * Call this whenever the narration state changes to keep the OS
 * media controls in sync with the actual playback state.
 *
 * @param state - The current playback state
 *
 * @example
 * ```typescript
 * // When play is pressed
 * narrator.play();
 * updateMediaSessionState("playing");
 *
 * // When paused
 * narrator.pause();
 * updateMediaSessionState("paused");
 *
 * // When stopped or article ends
 * narrator.stop();
 * updateMediaSessionState("none");
 * ```
 */
function updateMediaSessionState(state: MediaSessionPlaybackState): void {
  if (!isMediaSessionSupported()) {
    return;
  }

  navigator.mediaSession.playbackState = state;
}

/**
 * Clears the media session when leaving an article.
 *
 * This function:
 * - Resets the playback state to "none"
 * - Clears the metadata
 * - Removes all action handlers
 *
 * Call this when navigating away from an article to clean up
 * the media session and prevent stale controls from appearing.
 *
 * @example
 * ```typescript
 * // In a React component's cleanup
 * useEffect(() => {
 *   setupMediaSession({ ... });
 *
 *   return () => {
 *     clearMediaSession();
 *   };
 * }, []);
 * ```
 */
export function clearMediaSession(): void {
  if (!isMediaSessionSupported()) {
    return;
  }

  // Reset playback state
  navigator.mediaSession.playbackState = "none";

  // Clear metadata
  navigator.mediaSession.metadata = null;

  // Remove all action handlers by setting them to null
  const actions: MediaSessionAction[] = ["play", "pause", "stop", "previoustrack", "nexttrack"];

  for (const action of actions) {
    try {
      navigator.mediaSession.setActionHandler(action, null);
    } catch {
      // Some browsers may throw if the action is not supported
      // We can safely ignore this
    }
  }
}

/**
 * Creates a state change callback that automatically updates the media session.
 *
 * This is a convenience function that returns a callback suitable for use with
 * `ArticleNarrator.onStateChange()`. It maps narration status to media session
 * playback state.
 *
 * @returns A callback function for ArticleNarrator.onStateChange()
 *
 * @example
 * ```typescript
 * const narrator = new ArticleNarrator();
 * const unsubscribe = narrator.onStateChange(createMediaSessionStateHandler());
 *
 * // Later, clean up
 * unsubscribe();
 * ```
 */
export function createMediaSessionStateHandler(): (state: {
  status: "idle" | "loading" | "playing" | "paused";
}) => void {
  return (state) => {
    switch (state.status) {
      case "playing":
        updateMediaSessionState("playing");
        break;
      case "paused":
        updateMediaSessionState("paused");
        break;
      case "idle":
      case "loading":
        updateMediaSessionState("none");
        break;
    }
  };
}
