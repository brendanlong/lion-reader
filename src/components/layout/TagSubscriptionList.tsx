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
import { SubscriptionItem } from "./SubscriptionItem";

interface TagSubscriptionListProps {
  /** Tag ID to filter by, or undefined for uncategorized */
  tagId?: string;
  /** Whether to show uncategorized subscriptions (no tags) */
  uncategorized?: boolean;
  /** Current pathname for active state */
  pathname: string;
  /** Callback when sidebar should close (mobile) */
  onClose: () => void;
  /** Callback to edit a subscription */
  onEdit: (sub: {
    id: string;
    title: string;
    customTitle: string | null;
    tagIds: string[];
  }) => void;
  /** Callback to unsubscribe */
  onUnsubscribe: (sub: { id: string; title: string }) => void;
  /** When true, only show subscriptions with unread entries */
  unreadOnly: boolean;
}

export function TagSubscriptionList({
  tagId,
  uncategorized,
  pathname,
  onClose,
  onEdit,
  onUnsubscribe,
  unreadOnly,
}: TagSubscriptionListProps) {
  const sentinelRef = useRef<HTMLLIElement>(null);

  const subscriptionsQuery = trpc.subscriptions.list.useInfiniteQuery(
    { tagId, uncategorized, unreadOnly: unreadOnly || undefined, limit: 50 },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  const allSubscriptions = subscriptionsQuery.data?.pages.flatMap((p) => p.items) ?? [];

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = subscriptionsQuery;

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
            <div className="h-9 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800" />
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
          isActive={pathname === `/subscription/${sub.id}`}
          onClose={onClose}
          onEdit={() =>
            onEdit({
              id: sub.id,
              title: sub.title || "Untitled Feed",
              customTitle: sub.title !== sub.originalTitle ? sub.title : null,
              tagIds: sub.tags.map((t) => t.id),
            })
          }
          onUnsubscribe={() =>
            onUnsubscribe({
              id: sub.id,
              title: sub.title || "Untitled Feed",
            })
          }
        />
      ))}
      {/* Sentinel for infinite scroll */}
      {subscriptionsQuery.hasNextPage && (
        <li ref={sentinelRef} className="h-1" aria-hidden="true" />
      )}
    </ul>
  );
}
