/**
 * useMediaSession Hook
 *
 * Wires narration into the OS Media Session so an installed PWA (and any browser)
 * shows native media controls — the lock-screen/notification widget and
 * hardware/Bluetooth play-pause & track buttons — while narration is active.
 *
 * Provider-agnostic: it takes plain control callbacks and the current status, so
 * the same hook covers both browser voices and Piper enhanced voices.
 *
 * @module narration/useMediaSession
 */

"use client";

import { useEffect, useRef } from "react";
import type { NarrationStatus } from "@/lib/narration/ArticleNarrator";
import {
  setupMediaSession,
  updateMediaSessionPlaybackState,
  clearMediaSession,
  type MediaSessionControls,
} from "@/lib/narration/media-session";

/**
 * Parameters for {@link useMediaSession}.
 */
export interface UseMediaSessionParams {
  /**
   * Whether an OS media session should exist. Typically
   * `isSupported && narrationHasBeenGenerated`. When false, the session is torn
   * down and no controls are shown.
   */
  active: boolean;
  /** Article title shown in the OS controls. */
  title: string;
  /** Feed/site name shown as the artist. */
  feedTitle: string;
  /** Optional artwork URL. */
  artwork?: string;
  /** Current narration status, mirrored onto the OS controls. */
  status: NarrationStatus;
  /** Playback controls invoked by OS media buttons. */
  controls: MediaSessionControls;
}

/**
 * Keeps the OS Media Session (metadata, action handlers, playback state) in sync
 * with narration.
 *
 * OS button handlers are registered once per session but always dispatch to the
 * latest `controls` via a ref, so they never call stale closures.
 */
export function useMediaSession({
  active,
  title,
  feedTitle,
  artwork,
  status,
  controls,
}: UseMediaSessionParams): void {
  // Keep the latest controls in a ref so the action handlers registered with the
  // OS always call current callbacks without needing to re-register. Updated in
  // an effect (not during render); the handlers only fire from async OS button
  // events, never during render, so the effect-timing is safe.
  const controlsRef = useRef(controls);
  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  // Set up / tear down the session and its metadata.
  useEffect(() => {
    if (!active) return;

    setupMediaSession(
      { articleTitle: title, feedTitle, artwork },
      {
        play: () => controlsRef.current.play(),
        pause: () => controlsRef.current.pause(),
        stop: () => controlsRef.current.stop(),
        previousTrack: () => controlsRef.current.previousTrack(),
        nextTrack: () => controlsRef.current.nextTrack(),
      }
    );

    return () => {
      clearMediaSession();
    };
  }, [active, title, feedTitle, artwork]);

  // Mirror playback status onto the OS controls (and drive the silent-audio
  // element that keeps them visible).
  useEffect(() => {
    if (!active) return;
    updateMediaSessionPlaybackState(status);
  }, [active, status]);
}
