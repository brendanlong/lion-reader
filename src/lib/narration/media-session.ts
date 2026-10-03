/**
 * Media Session API Integration for Lion Reader's Narration Feature
 *
 * Enables OS-level playback controls when narration is active:
 * - Lock screen / notification media controls (iOS/Android, incl. installed PWA)
 * - Keyboard media keys (play/pause, prev/next)
 * - Headphone / Bluetooth device buttons
 *
 * Browser voices (Web Speech API) don't register as media playback, so the OS
 * won't show media controls just because we set `mediaSession.metadata`. For
 * them, a silent looping audio element (see `./silent-audio`) is played while
 * narration is active to make the browser treat narration as "media", which is
 * what surfaces the controls and routes hardware buttons to our action
 * handlers. Piper and cloud voices play through their own media element (see
 * `./media-source-player`) and skip the silent loop.
 *
 * This module is provider-agnostic: callers pass plain control callbacks, so the
 * same integration works for every voice.
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
import type { NarrationStatus } from "./types";
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
  "generating",
  "buffering",
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
 * Offers the OS's previous/next buttons only where there's a paragraph to go
 * to, so they grey out on the first and last. Call after
 * {@link setupMediaSession}, which offers both.
 */
export function setMediaSessionSkips(
  controls: Pick<MediaSessionControls, "previousTrack" | "nextTrack">,
  { previous, next }: { previous: boolean; next: boolean }
): void {
  if (!isMediaSessionSupported()) return;
  navigator.mediaSession.setActionHandler(
    "previoustrack",
    previous ? () => controls.previousTrack() : null
  );
  navigator.mediaSession.setActionHandler("nexttrack", next ? () => controls.nextTrack() : null);
}

/**
 * Synchronizes the OS media session with the current narration status and drives
 * the silent audio element that keeps the controls visible.
 *
 * - `idle`: stops the silent loop, deactivating the OS session.
 * - anything else: keeps the silent loop playing so the OS session stays
 *   active, and reflects play vs. pause on the controls.
 *
 * Call this whenever narration status changes. Reachability from a user gesture
 * (or sticky activation) matters for the first non-idle transition so
 * autoplay policies allow the silent audio to start.
 *
 * @param status - The current narration status
 * @param useSilentAudio - False when narration plays through its own media
 *   element, which a second (silent) element would interrupt on iOS
 */
export function updateMediaSessionPlaybackState(
  status: NarrationStatus,
  useSilentAudio = true
): void {
  if (!isMediaSessionSupported()) {
    return;
  }

  if (ACTIVE_STATUSES.has(status)) {
    // Keep (or start) the silent loop so the OS treats narration as media.
    if (useSilentAudio) startSilentAudio();
    else stopSilentAudio();
    navigator.mediaSession.playbackState = status === "paused" ? "paused" : "playing";
  } else {
    stopSilentAudio();
    navigator.mediaSession.playbackState = "none";
  }
}

/**
 * Bumped by every prime. The silent element is a page-wide singleton, so a
 * request that is abandoned while generating (e.g. its entry was closed and the
 * next one started narrating) must not stop audio a later prime now depends on.
 */
let primeGeneration = 0;

/**
 * Starts the silent audio loop immediately.
 *
 * Call this synchronously from within the user gesture that begins narration, so
 * the browser grants the media session before any async work (e.g. LLM narration
 * generation) consumes the gesture's autoplay activation — otherwise the later
 * `startSilentAudio()` from {@link updateMediaSessionPlaybackState} can be
 * rejected by autoplay policy and the OS controls never appear. Safe to call
 * before metadata is set; {@link updateMediaSessionPlaybackState} keeps it going
 * once playback begins. If playback never starts (generation fails or the
 * request is abandoned), release it with {@link releasePrimedMediaSessionAudio}.
 *
 * @returns The prime's generation, to hand back to the release.
 */
export function primeMediaSessionAudio(): number {
  primeGeneration++;
  if (isMediaSessionSupported()) {
    startSilentAudio();
  }
  return primeGeneration;
}

/**
 * Stops the silent audio loop started by {@link primeMediaSessionAudio} when
 * playback never began, without clearing metadata/action handlers — unless a
 * later prime has taken the element over since.
 */
export function releasePrimedMediaSessionAudio(generation: number): void {
  if (generation === primeGeneration) {
    stopSilentAudio();
  }
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
