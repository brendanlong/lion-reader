/**
 * Media Session API Integration for Lion Reader's Narration Feature
 *
 * Enables OS-level playback controls when narration is active:
 * - Lock screen / notification media controls (iOS/Android, incl. installed PWA)
 * - Keyboard media keys (play/pause, prev/next)
 * - Headphone / Bluetooth device buttons
 *
 * Narration plays through the Web Speech API (browser voices) or the Web Audio
 * API (Piper enhanced voices). Neither registers as media playback, so the OS
 * won't show media controls just because we set `mediaSession.metadata`. A silent
 * looping audio element (see `./silent-audio`) is played while narration is
 * active to make the browser treat narration as "media", which is what surfaces
 * the controls and routes hardware buttons to our action handlers.
 *
 * This module is provider-agnostic: callers pass plain control callbacks, so the
 * same integration works for both browser voices and Piper TTS.
 *
 * Usage:
 * ```typescript
 * setupMediaSession(
 *   { articleTitle: "Article Title", feedTitle: "Feed Name", artwork },
 *   { play, pause, stop, previousTrack, nextTrack },
 * );
 *
 * // Keep the OS controls in sync with playback:
 * updateMediaSessionPlaybackState("playing");
 *
 * // When leaving the article:
 * clearMediaSession();
 * ```
 */

import { isMediaSessionSupported } from "./feature-detection";
import type { NarrationStatus } from "./ArticleNarrator";
import { startSilentAudio, stopSilentAudio } from "./silent-audio";

/**
 * Provider-agnostic playback controls invoked by OS media buttons.
 *
 * These map directly onto the narration hook's controls so both browser voices
 * and Piper TTS share one integration.
 */
export interface MediaSessionControls {
  /** Resume/start playback (OS "play" button, media key). */
  play: () => void;
  /** Pause playback (OS "pause" button, media key). */
  pause: () => void;
  /** Stop playback entirely. */
  stop: () => void;
  /** Skip to the previous paragraph (prev-track button). */
  previousTrack: () => void;
  /** Skip to the next paragraph (next-track button). */
  nextTrack: () => void;
}

/**
 * Metadata describing the currently-narrated article.
 */
export interface MediaSessionMetadataInput {
  /** Title of the article being narrated */
  articleTitle: string;
  /** Name of the feed/site the article is from */
  feedTitle: string;
  /** Optional URL to artwork/icon to display in media controls */
  artwork?: string;
}

/**
 * The narration statuses that keep an OS media session active. `idle` tears it
 * down; the rest keep the silent loop playing so the controls persist.
 */
const ACTIVE_STATUSES: ReadonlySet<NarrationStatus> = new Set<NarrationStatus>([
  "loading",
  "playing",
  "paused",
]);

/**
 * Sets up the Media Session API for OS-level playback controls.
 *
 * Sets metadata (title, artist, album, artwork) and registers action handlers.
 * Playback state (and the silent-audio element that makes the controls appear)
 * is driven separately by {@link updateMediaSessionPlaybackState}.
 *
 * No-op when the Media Session API is unsupported (graceful degradation).
 *
 * @param metadata - What to display in the OS controls
 * @param controls - Callbacks invoked by the OS media buttons
 */
export function setupMediaSession(
  metadata: MediaSessionMetadataInput,
  controls: MediaSessionControls
): void {
  if (!isMediaSessionSupported()) {
    return;
  }

  const { articleTitle, feedTitle, artwork } = metadata;

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

  navigator.mediaSession.setActionHandler("play", () => controls.play());
  navigator.mediaSession.setActionHandler("pause", () => controls.pause());
  navigator.mediaSession.setActionHandler("stop", () => controls.stop());
  navigator.mediaSession.setActionHandler("previoustrack", () => controls.previousTrack());
  navigator.mediaSession.setActionHandler("nexttrack", () => controls.nextTrack());
}

/**
 * Synchronizes the OS media session with the current narration status and drives
 * the silent audio element that keeps the controls visible.
 *
 * - `loading` / `playing` / `paused`: keeps the silent loop playing so the OS
 *   session stays active, and reflects play vs. pause on the controls.
 * - `idle`: stops the silent loop, deactivating the OS session.
 *
 * Call this whenever narration status changes. Reachability from a user gesture
 * (or sticky activation) matters for the first `loading`/`playing` transition so
 * autoplay policies allow the silent audio to start.
 *
 * @param status - The current narration status
 */
export function updateMediaSessionPlaybackState(status: NarrationStatus): void {
  if (!isMediaSessionSupported()) {
    return;
  }

  if (ACTIVE_STATUSES.has(status)) {
    // Keep (or start) the silent loop so the OS treats narration as media.
    startSilentAudio();
    navigator.mediaSession.playbackState = status === "paused" ? "paused" : "playing";
  } else {
    stopSilentAudio();
    navigator.mediaSession.playbackState = "none";
  }
}

/**
 * Starts the silent audio loop immediately.
 *
 * Call this synchronously from within the user gesture that begins narration, so
 * the browser grants the media session before any async work (e.g. LLM narration
 * generation) consumes the gesture's autoplay activation — otherwise the later
 * `startSilentAudio()` from {@link updateMediaSessionPlaybackState} can be
 * rejected by autoplay policy and the OS controls never appear. Safe to call
 * before metadata is set; {@link updateMediaSessionPlaybackState} keeps it going
 * once playback begins. If playback never starts (generation fails), release it
 * with {@link stopMediaSessionAudio} or {@link clearMediaSession}.
 */
export function primeMediaSessionAudio(): void {
  if (!isMediaSessionSupported()) {
    return;
  }
  startSilentAudio();
}

/**
 * Stops the silent audio loop without clearing metadata/action handlers.
 *
 * Used to release a session primed by {@link primeMediaSessionAudio} when
 * narration generation fails before playback actually begins.
 */
export function stopMediaSessionAudio(): void {
  stopSilentAudio();
}

/**
 * Clears the media session when leaving an article.
 *
 * Stops the silent audio loop, resets playback state, clears metadata, and
 * removes all action handlers so stale controls don't linger.
 */
export function clearMediaSession(): void {
  // Always stop the silent loop, even if the Media Session API itself is
  // unsupported, so the element never keeps looping.
  stopSilentAudio();

  if (!isMediaSessionSupported()) {
    return;
  }

  navigator.mediaSession.playbackState = "none";
  navigator.mediaSession.metadata = null;

  const actions: MediaSessionAction[] = ["play", "pause", "stop", "previoustrack", "nexttrack"];
  for (const action of actions) {
    try {
      navigator.mediaSession.setActionHandler(action, null);
    } catch {
      // Some browsers throw for unsupported actions; safe to ignore.
    }
  }
}
