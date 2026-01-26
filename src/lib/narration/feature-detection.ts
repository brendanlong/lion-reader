/**
 * Feature detection utilities for the narration feature.
 *
 * These utilities check for browser support of the Web Speech API
 * and Media Session API, allowing the UI to gracefully hide
 * narration controls in unsupported browsers.
 */

/**
 * Checks if the Web Speech API (text-to-speech) is supported.
 *
 * Returns true if the browser supports:
 * - `window.speechSynthesis` - The speech synthesis interface
 * - `SpeechSynthesisUtterance` - The utterance constructor
 *
 * @returns true if narration is supported, false otherwise.
 *
 * @example
 * ```tsx
 * function NarrationControls() {
 *   if (!isNarrationSupported()) {
 *     return null; // Don't render in unsupported browsers
 *   }
 *   return <PlayButton />;
 * }
 * ```
 */
export function isNarrationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window
  );
}

/**
 * Checks if the Media Session API is supported.
 *
 * The Media Session API enables OS-level playback controls:
 * - Lock screen controls
 * - Keyboard media keys
 * - Headphone buttons
 * - Notification center media controls
 *
 * @returns true if Media Session API is available, false otherwise.
 *
 * @example
 * ```ts
 * if (isMediaSessionSupported()) {
 *   navigator.mediaSession.metadata = new MediaMetadata({
 *     title: article.title,
 *     artist: feed.title,
 *   });
 * }
 * ```
 */
export function isMediaSessionSupported(): boolean {
  return typeof navigator !== "undefined" && "mediaSession" in navigator;
}

/**
 * Detailed narration support information.
 */
export interface NarrationSupportInfo {
  /**
   * Whether the core narration feature (Web Speech API) is supported.
   */
  supported: boolean;

  /**
   * Whether Media Session API is available for OS-level controls.
   */
  mediaSession: boolean;

  /**
   * Human-readable reason if narration is not supported.
   * Undefined if narration is supported.
   */
  reason?: string;
}

/**
 * Detects if the current browser is Firefox.
 *
 * Firefox has a known bug where `speechSynthesis.pause()` and
 * `speechSynthesis.resume()` don't work properly. We use this
 * to implement a workaround (cancel + restart from paragraph).
 *
 * @returns true if running in Firefox, false otherwise.
 *
 * @see https://bugzilla.mozilla.org/show_bug.cgi?id=1316808
 */
export function isFirefox(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return navigator.userAgent.toLowerCase().includes("firefox");
}

/**
 * Checks if background audio playback is supported.
 *
 * Background audio playback requires:
 * - WebCodecs API (AudioEncoder) for encoding PCM to Opus
 * - HTMLAudioElement for playback
 *
 * This enables playback to continue when the app is in the background
 * on mobile devices, and shows media controls in the notification area.
 *
 * @returns true if background audio is supported, false otherwise.
 */
export function isBackgroundAudioSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof HTMLAudioElement !== "undefined" &&
    typeof AudioEncoder !== "undefined"
  );
}

// Cached result for getNarrationSupportInfo to ensure referential stability
// (required for useSyncExternalStore to avoid infinite loops)
let cachedSupportInfo: NarrationSupportInfo | null = null;

/**
 * Gets detailed information about narration support.
 *
 * Use this when you need both the support status and a reason
 * for why narration might not be available (useful for showing
 * helpful error messages to users).
 *
 * The result is cached to ensure referential stability when used with
 * useSyncExternalStore (browser capabilities don't change during a session).
 *
 * @returns Object with support status and optional reason.
 *
 * @example
 * ```tsx
 * function NarrationStatus() {
 *   const info = getNarrationSupportInfo();
 *
 *   if (!info.supported) {
 *     return <p>Narration unavailable: {info.reason}</p>;
 *   }
 *
 *   return (
 *     <div>
 *       <p>Narration is available!</p>
 *       {info.mediaSession && <p>Media keys supported</p>}
 *     </div>
 *   );
 * }
 * ```
 */
export function getNarrationSupportInfo(): NarrationSupportInfo {
  // Return cached result if available (browser capabilities don't change)
  if (cachedSupportInfo !== null) {
    return cachedSupportInfo;
  }

  // Server-side rendering check
  if (typeof window === "undefined") {
    // Don't cache server-side result since we want to recompute on client
    return {
      supported: false,
      mediaSession: false,
      reason: "Narration is only available in the browser",
    };
  }

  // Check for speechSynthesis
  if (!("speechSynthesis" in window)) {
    cachedSupportInfo = {
      supported: false,
      mediaSession: isMediaSessionSupported(),
      reason: "Your browser does not support the Web Speech API",
    };
    return cachedSupportInfo;
  }

  // Check for SpeechSynthesisUtterance
  if (!("SpeechSynthesisUtterance" in window)) {
    cachedSupportInfo = {
      supported: false,
      mediaSession: isMediaSessionSupported(),
      reason: "Your browser does not support speech synthesis",
    };
    return cachedSupportInfo;
  }

  // All checks passed
  cachedSupportInfo = {
    supported: true,
    mediaSession: isMediaSessionSupported(),
  };
  return cachedSupportInfo;
}
