"use client";

import { useMemo } from "react";

/**
 * Public base URL for links shown to the user: NEXT_PUBLIC_APP_URL when set
 * (available on server and client), else the browser's origin ("" during SSR).
 */
export function useAppBaseUrl(): string {
  return useMemo(
    () =>
      process.env.NEXT_PUBLIC_APP_URL ||
      (typeof window !== "undefined" ? window.location.origin : ""),
    []
  );
}
