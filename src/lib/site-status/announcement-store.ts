/**
 * Live announcement store.
 *
 * The announcement banner is server-rendered from the authenticated SPA layout
 * (`src/app/(app)/layout.tsx`), and the SSE handler that receives
 * `announcement_changed` events lives deeper inside the same app. This
 * module-level store bridges the two — the SSE handler writes here, the banner
 * subscribes via useSyncExternalStore — with no shared React context needed
 * (same pattern as `useSidebarUnreadOnly`).
 *
 * The snapshot is tri-state:
 * - `undefined` — no live update has arrived; the banner uses its SSR prop.
 * - `null` — a live update cleared/disabled the announcement; hide the banner.
 * - an object — a live update set a new announcement; show it.
 *
 * Keeping `undefined` distinct from `null` is what lets a live "cleared" event
 * actually hide the banner instead of falling back to the stale SSR value.
 */

"use client";

import { useSyncExternalStore } from "react";
import type { AnnouncementLevel } from "@/server/services/site-status";

export interface LiveAnnouncement {
  id: string;
  message: string;
  level: AnnouncementLevel;
}

let current: LiveAnnouncement | null | undefined = undefined;
const listeners = new Set<() => void>();

/** Called by the SSE `announcement_changed` handler. */
export function setLiveAnnouncement(announcement: LiveAnnouncement | null): void {
  current = announcement;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): LiveAnnouncement | null | undefined {
  return current;
}

function getServerSnapshot(): LiveAnnouncement | null | undefined {
  // No live update on the server — the banner renders from its SSR prop.
  return undefined;
}

/**
 * The live announcement override, or `undefined` when no SSE update has arrived
 * yet (the banner should use its server-provided initial value in that case).
 */
export function useLiveAnnouncement(): LiveAnnouncement | null | undefined {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
