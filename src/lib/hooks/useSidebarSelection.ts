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
import type { SubscriptionRow } from "@/lib/local-db/subscriptions";
import { isInSidebarSection } from "@/lib/sidebar-sections";
import { useAppPathname } from "./useAppLocation";
import { useExpandedTags } from "./useExpandedTags";
import { useLocalSubscription } from "./useLocalSubscriptions";

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
   * no copy shown in the sidebar was chosen for this route (a deep link, or the
   * chosen tag was collapsed): then every copy is current.
   */
  section: string | null;
  /** The open subscription, so the sidebar keeps listing it once it's read */
  subscription: SubscriptionRow | undefined;
}

export function useSidebarSelection(): SidebarSelection {
  const pathname = useAppPathname();
  const chosenSection = useSyncExternalStore(
    subscribe,
    () => chosen,
    () => null
  );
  const { isExpanded } = useExpandedTags();
  const { subscriptionId } = extractParamsFromPathname(pathname);
  // Loads it into the store (the subscription page fetches it too, so it's
  // normally a cache hit).
  trpc.subscriptions.get.useQuery({ id: subscriptionId ?? "" }, { enabled: !!subscriptionId });
  const current = useLocalSubscription(subscriptionId);
  const chosenCopyShown =
    chosenSection?.href === pathname &&
    isExpanded(chosenSection.section) &&
    !!current &&
    isInSidebarSection(current, chosenSection.section);

  return {
    pathname,
    section: chosenCopyShown ? chosenSection.section : null,
    subscription: current,
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
