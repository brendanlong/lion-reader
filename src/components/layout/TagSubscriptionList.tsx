/**
 * TagSubscriptionList Component
 *
 * Renders subscriptions within a tag section using a TanStack DB on-demand collection.
 * The collection fetches pages from the server as the user scrolls in the sidebar.
 *
 * Loaded subscriptions are also written into the global subscriptions collection
 * for fast lookups and optimistic updates elsewhere in the app.
 */

"use client";

import { useEffect, useMemo, useRef } from "react";
import { useLiveInfiniteQuery } from "@tanstack/react-db";
import { useCollections } from "@/lib/collections/context";
import { upsertSubscriptionsInCollection } from "@/lib/collections/writes";
import { useTagSubscriptionsCollection } from "@/lib/hooks/useTagSubscriptionsCollection";
import type { TagSubscriptionFilters } from "@/lib/collections/subscriptions";
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

const PAGE_SIZE = 50;

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
  const collections = useCollections();

  // Build filters for the on-demand collection
  const filters: TagSubscriptionFilters = useMemo(
    () => ({ tagId, uncategorized, unreadOnly: unreadOnly || undefined, limit: PAGE_SIZE }),
    [tagId, uncategorized, unreadOnly]
  );

  // Create the on-demand collection (recreates on filter change)
  const { collection: tagCollection, filterKey } = useTagSubscriptionsCollection(filters);

  // Register the tag subscription collection so write functions can propagate
  // unread count changes to it (in addition to the global subscriptions collection)
  useEffect(() => {
    collections.tagSubscriptionCollections.set(filterKey, tagCollection);
    return () => {
      collections.tagSubscriptionCollections.delete(filterKey);
    };
  }, [collections, filterKey, tagCollection]);

  // Live infinite query over the tag subscription collection
  // Server sorts alphabetically by title, so we use ID as the orderBy
  // (UUIDv7 gives us stable ordering; the server determines the actual sort)
  const {
    data: subscriptions,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isReady,
  } = useLiveInfiniteQuery(
    (q) =>
      q
        .from({ s: tagCollection })
        .orderBy(({ s }) => s.id, "asc")
        .select(({ s }) => ({ ...s })),
    {
      pageSize: PAGE_SIZE,
      getNextPageParam: (lastPage, allPages) =>
        lastPage.length === PAGE_SIZE ? allPages.length : undefined,
    },
    [filterKey]
  );

  // Populate global subscriptions collection from live query results
  useEffect(() => {
    if (subscriptions && subscriptions.length > 0) {
      upsertSubscriptionsInCollection(collections, subscriptions);
    }
  }, [collections, subscriptions]);

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

  if (isLoading && !isReady) {
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

  if (!subscriptions || subscriptions.length === 0) {
    return null;
  }

  return (
    <ul className="mt-1 ml-6 space-y-1">
      {subscriptions.map((sub) => (
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
      {hasNextPage && <li ref={sentinelRef} className="h-1" aria-hidden="true" />}
    </ul>
  );
}
