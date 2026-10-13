"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Once `armed`, the next client-side navigation becomes a full page load, so a
 * page left open across a deploy picks up the new JavaScript without
 * discarding what the reader is looking at now. Unmounting while armed counts
 * as navigating: it means the route left the layout that mounts this.
 */
export function useReloadOnNextNavigation(armed: boolean): void {
  const pathname = usePathname();
  const armedAt = useRef<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    if (armedAt.current === null) armedAt.current = pathname;
    else if (pathname !== armedAt.current) window.location.reload();
  }, [armed, pathname]);
  useEffect(
    () => () => {
      if (armedAt.current !== null) window.location.reload();
    },
    []
  );
}
