/**
 * TagSubscriptionList Component
 *
 * Renders subscriptions within a tag section using infinite scrolling.
 * Subscriptions are fetched per-tag (or uncategorized) when the section is expanded,
 * with more pages loaded automatically as the user scrolls.
 */

"use client";

import { useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc/client";
import type { CachedSubscription } from "@/lib/cache/count-cache";
import {
  UNCATEGORIZED_SECTION,
  chooseSidebarSection,
  isInSidebarSection,
  isSidebarLinkCurrent,
  type SidebarSelection,
} from "@/lib/hooks/useSidebarSelection";
import { SubscriptionItem } from "./SubscriptionItem";
import { untitledSubscriptionLabel } from "@/lib/collections";

interface TagSubscriptionListProps {
  /** Tag ID to filter by, or undefined for uncategorized */
  tagId?: string;
  /** Whether to show uncategorized subscriptions (no tags) */
  uncategorized?: boolean;
  /** What the sidebar treats as current */
  selection: SidebarSelection;
  /** Called with the link href when a subscription link is clicked (closes mobile sidebar) */
  onClose: (href: string) => void;
  /** Callback to edit a subscription */
  onEdit: (sub: {
    id: string;
    title: string;
    customTitle: string | null;
    tagIds: string[];
    isCollection: boolean;
  }) => void;
  /** Callback to unsubscribe */
  onUnsubscribe: (sub: { id: string; title: string; isCollection: boolean }) => void;
  /** When true, only show subscriptions with unread entries */
  unreadOnly: boolean;
  /** Called on mousedown with the link href (e.g., to prefetch data) */
  onPrefetch?: (href: string) => void;
}

/**
 * Keeps the open subscription listed in its sections after the unread-only
 * filter drops it (once it's read), in the server's title order. Past the
 * loaded pages it's left for a later page to bring in.
 */
function withCurrentSubscription(
  loaded: CachedSubscription[],
  current: CachedSubscription | undefined,
  section: string,
  hasNextPage: boolean
): CachedSubscription[] {
  if (!current || !isInSidebarSection(current, section)) return loaded;
  if (loaded.some((sub) => sub.id === current.id)) return loaded;
  const sortKey = (sub: CachedSubscription) => sub.title ?? "";
  const index = loaded.findIndex(
    (sub) =>
      sortKey(sub).localeCompare(sortKey(current)) > 0 ||
      (sortKey(sub) === sortKey(current) && sub.id > current.id)
  );
  if (index === -1) return hasNextPage ? loaded : [...loaded, current];
  return [...loaded.slice(0, index), current, ...loaded.slice(index)];
}

export function TagSubscriptionList({
  tagId,
  uncategorized,
  selection,
  onClose,
  onEdit,
  onUnsubscribe,
  unreadOnly,
  onPrefetch,
}: TagSubscriptionListProps) {
  const sentinelRef = useRef<HTMLLIElement>(null);

  const subscriptionsQuery = trpc.subscriptions.list.useInfiniteQuery(
    { tagId, uncategorized, unreadOnly: unreadOnly || undefined, limit: 50 },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = subscriptionsQuery;
  const section = tagId ?? UNCATEGORIZED_SECTION;

  const allSubscriptions = withCurrentSubscription(
    subscriptionsQuery.data?.pages.flatMap((p) => p.items) ?? [],
    selection.subscription,
    section,
    hasNextPage
  );

  const handleClose = (href: string) => {
    chooseSidebarSection(href, section);
    onClose(href);
  };

  // Infinite scroll: observe sentinel element to load more
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return;

    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          fetchNextPage();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (subscriptionsQuery.isLoading) {
    return (
      <ul className="mt-1 ml-6 space-y-1">
        {[1, 2].map((i) => (
          <li key={i}>
            <div className="bg-fill-muted h-9 animate-pulse rounded-md" />
          </li>
        ))}
      </ul>
    );
  }

  if (allSubscriptions.length === 0) {
    return null;
  }

  return (
    <ul className="mt-1 ml-6 space-y-1">
      {allSubscriptions.map((sub) => (
        <SubscriptionItem
          key={sub.id}
          subscription={sub}
          isActive={isSidebarLinkCurrent(selection, `/subscription/${sub.id}`, section)}
          onClose={handleClose}
          onEdit={() =>
            onEdit({
              id: sub.id,
              title: sub.title || untitledSubscriptionLabel(sub.type),
              customTitle: sub.title !== sub.originalTitle ? sub.title : null,
              tagIds: sub.tags.map((t) => t.id),
              isCollection: sub.type === "collection",
            })
          }
          onUnsubscribe={() =>
            onUnsubscribe({
              id: sub.id,
              title: sub.title || untitledSubscriptionLabel(sub.type),
              isCollection: sub.type === "collection",
            })
          }
          onPrefetch={onPrefetch}
        />
      ))}
      {/* Sentinel for infinite scroll */}
      {subscriptionsQuery.hasNextPage && (
        <li ref={sentinelRef} className="h-1" aria-hidden="true" />
      )}
    </ul>
  );
}
