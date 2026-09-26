"use client";

import { useCallback } from "react";
import { createStoredBoolean } from "@/lib/stored-boolean";

/**
 * Whether the sidebar shows only tags/subscriptions with unread entries
 * (default: true), persisted to localStorage.
 */
const store = createStoredBoolean("lion-reader-sidebar-unread-only", true);

export interface UseSidebarUnreadOnlyResult {
  /** Whether to show only tags/subscriptions with unread entries */
  sidebarUnreadOnly: boolean;
  /** Toggle the sidebar unread filter */
  toggleSidebarUnreadOnly: () => void;
}

export function useSidebarUnreadOnly(): UseSidebarUnreadOnlyResult {
  const sidebarUnreadOnly = store.useValue();
  const toggleSidebarUnreadOnly = useCallback(() => store.set(!store.get()), []);
  return { sidebarUnreadOnly, toggleSidebarUnreadOnly };
}
