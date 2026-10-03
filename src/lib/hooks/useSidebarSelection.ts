/**
 * useSidebarSelection Hook
 *
 * What the sidebar treats as current: the route, plus which section's copy of
 * a subscription was chosen (a subscription with several tags is listed under
 * each). Highlighting, the unread-only filter's "keep the current item" rule,
 * and Shift+J/Shift+K all read it from here so they can't disagree.
 */

"use client";

import { useSyncExternalStore } from "react";
import { trpc } from "@/lib/trpc/client";
import { extractParamsFromPathname } from "@/lib/navigation";
import type { CachedSubscription } from "@/lib/cache/count-cache";
import { useAppPathname } from "./useAppLocation";

/** Section key for subscriptions without tags. */
export const UNCATEGORIZED_SECTION = "uncategorized";

interface ChosenSection {
  href: string;
  section: string;
}

let chosen: ChosenSection | null = null;
const listeners = new Set<() => void>();

/** Records which section a subscription link was chosen from. */
export function chooseSidebarSection(href: string, section: string): void {
  chosen = { href, section };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface SidebarSelection {
  /** App-relative pathname of the current view */
  pathname: string;
  /**
   * The section whose copy of the open subscription is current, or null when
   * none was chosen (deep link, back button): then every copy is current.
   */
  section: string | null;
  /** The open subscription, so the sidebar keeps listing it once it's read */
  subscription: CachedSubscription | undefined;
}

export function useSidebarSelection(): SidebarSelection {
  const pathname = useAppPathname();
  const chosenSection = useSyncExternalStore(
    subscribe,
    () => chosen,
    () => null
  );
  const { subscriptionId } = extractParamsFromPathname(pathname);
  // The subscription page fetches this too, so it's normally a cache hit.
  const { data: subscription } = trpc.subscriptions.get.useQuery(
    { id: subscriptionId ?? "" },
    { enabled: !!subscriptionId }
  );

  return {
    pathname,
    section: chosenSection?.href === pathname ? chosenSection.section : null,
    subscription: subscriptionId ? subscription : undefined,
  };
}

/** Whether the sidebar link to `href` (under `section`, for subscriptions) is current. */
export function isSidebarLinkCurrent(
  selection: SidebarSelection,
  href: string,
  section?: string
): boolean {
  return (
    selection.pathname === href &&
    (section === undefined || selection.section === null || selection.section === section)
  );
}

/** Whether `subscription` is listed in `section` of the sidebar. */
export function isInSidebarSection(subscription: CachedSubscription, section: string): boolean {
  return section === UNCATEGORIZED_SECTION
    ? subscription.tags.length === 0
    : subscription.tags.some((tag) => tag.id === section);
}
