"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};
const getBrowserBaseUrl = (): string => process.env.NEXT_PUBLIC_APP_URL || window.location.origin;
const getServerBaseUrl = (): string => process.env.NEXT_PUBLIC_APP_URL || "";

/**
 * Public base URL for links shown to the user: NEXT_PUBLIC_APP_URL when set,
 * else the browser's origin. Without the env var, the server render and
 * hydration see "" and the origin fills in right after (#2277).
 */
export function useAppBaseUrl(): string {
  return useSyncExternalStore(noopSubscribe, getBrowserBaseUrl, getServerBaseUrl);
}
