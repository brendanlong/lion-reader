/**
 * E-ink display detection.
 *
 * Used to resolve the "Auto" theme to the e-paper theme on e-reader screens
 * (issue #1017). Detection is best-effort: there is no standard "e-ink" media
 * query, so we combine the `(monochrome)` media query (matches greyscale e-ink
 * panels) with a user-agent check for known e-reader devices and browsers.
 * False negatives are fine — users can always select E-paper manually.
 */

"use client";

import { useSyncExternalStore } from "react";

/**
 * Known e-reader devices and e-ink browsers that identify themselves in the
 * user-agent string. EinkBro is the de-facto browser on Onyx Boox devices,
 * which otherwise don't mention e-ink in their UA.
 */
const EINK_USER_AGENT_PATTERN =
  /\b(?:Kobo|Kindle|EinkBro|Tolino|PocketBook|InkPalm|Likebook|Boyue|BOOX|reMarkable)\b/i;

/**
 * Pure user-agent check for known e-reader devices/browsers.
 */
export function isEInkUserAgent(userAgent: string): boolean {
  return EINK_USER_AGENT_PATTERN.test(userAgent);
}

/**
 * Detects whether the current display is (likely) an e-ink screen.
 * Client-only; returns false during SSR.
 */
function isEInkDisplay(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    if (window.matchMedia("(monochrome)").matches) {
      return true;
    }
  } catch {
    // matchMedia unavailable (very old browser) - fall through to UA check
  }
  return isEInkUserAgent(navigator.userAgent);
}

// The display type never changes within a session, so there's nothing to watch
function subscribeNever(): () => void {
  return () => {};
}

/**
 * React hook version of {@link isEInkDisplay}.
 *
 * Uses useSyncExternalStore so the server snapshot is false (SSR-safe) and the
 * client snapshot reflects the real display after hydration.
 */
export function useIsEInkDisplay(): boolean {
  return useSyncExternalStore(subscribeNever, isEInkDisplay, () => false);
}
