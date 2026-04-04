"use client";

import { useEffect, useRef } from "react";

/**
 * Requests a screen wake lock while `active` is true.
 * Automatically releases when `active` becomes false or on unmount.
 * Re-acquires the lock if the page regains visibility while still active.
 */
export function useWakeLock(active: boolean): void {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      return;
    }

    let cancelled = false;

    async function acquire() {
      if (wakeLockRef.current) {
        return;
      }

      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          await sentinel.release();
          return;
        }
        wakeLockRef.current = sentinel;
        sentinel.addEventListener("release", () => {
          if (wakeLockRef.current === sentinel) {
            wakeLockRef.current = null;
          }
        });
      } catch {
        // Wake lock request can fail (e.g. low battery, background tab)
      }
    }

    acquire();

    // Re-acquire when page becomes visible again (wake locks are released on visibility change)
    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && !cancelled) {
        acquire();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [active]);
}
