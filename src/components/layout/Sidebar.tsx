/**
 * Sidebar Component
 *
 * Navigation sidebar for the main app layout.
 * Shows navigation links, feed list with unread counts, and tags.
 *
 * Uses Suspense boundaries for streaming SSR:
 * - SidebarNav: streams unread counts independently
 * - TagList: streams tag structure with counts
 */

"use client";

import { useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { useUnsubscribeMutation } from "@/lib/hooks/useUnsubscribeMutation";
import { refreshEntryLists } from "@/lib/hooks/useEntryListRefreshOnNavigate";
import { buildEntriesListInputForRoute } from "@/lib/queries/entries-list-input";
import { UnsubscribeDialog } from "@/components/feeds/UnsubscribeDialog";
import { EditSubscriptionDialog } from "@/components/feeds/EditSubscriptionDialog";
import { useSidebarUnreadOnly } from "@/lib/hooks/useSidebarUnreadOnly";
import { SidebarNav } from "./SidebarNav";
import { TagList } from "./TagList";
import { SidebarUnreadToggle } from "./SidebarUnreadToggle";

interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const { sidebarUnreadOnly, toggleSidebarUnreadOnly } = useSidebarUnreadOnly();
  const [unsubscribeTarget, setUnsubscribeTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [editTarget, setEditTarget] = useState<{
    id: string;
    title: string;
    customTitle: string | null;
    tagIds: string[];
  } | null>(null);

  const utils = trpc.useUtils();

  // Close the dialog immediately on mutate; the shared hook owns the cache
  // choreography (optimistic remove, counts, entries.list invalidate, rollback).
  const unsubscribeMutation = useUnsubscribeMutation({
    onMutate: () => setUnsubscribeTarget(null),
  });

  const handleNavigate = (href: string) => {
    // Cross-list navigation is refreshed centrally by
    // useEntryListRefreshOnNavigate (on pathname change), which this click
    // can't trigger when the link points at the current page. Refresh here
    // so clicking the current list's link still acts as an explicit refresh,
    // keeping same-list and between-list clicks feeling the same.
    if (href === pathname) {
      void refreshEntryLists(queryClient);
    }
    onClose?.();
  };

  // Prefetch entries.list on mousedown (fires ~100-200ms before click).
  // Even though handleNavigate invalidates the cache, prefetched data will
  // still be available as stale data - useSuspenseInfiniteQuery renders stale
  // data immediately without suspending, then refetches in the background.
  const handlePrefetchRoute = useCallback(
    (href: string) => {
      const input = buildEntriesListInputForRoute(href);
      void utils.entries.list.prefetchInfinite(input, {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        pages: 1,
      });
    },
    [utils]
  );

  const handleEdit = (sub: {
    id: string;
    title: string;
    customTitle: string | null;
    tagIds: string[];
  }) => {
    setEditTarget(sub);
  };

  const handleUnsubscribe = (sub: { id: string; title: string }) => {
    setUnsubscribeTarget(sub);
  };

  return (
    <>
      <nav className="bg-surface flex h-full flex-col">
        {/* Main Navigation with streaming counts */}
        <SidebarNav onNavigate={handleNavigate} onPrefetch={handlePrefetchRoute} />

        {/* Divider with unread toggle */}
        <div className="border-edge-strong mx-3 flex items-center gap-2 border-t pt-2">
          <span className="ui-text-xs text-muted flex-1 font-medium">Feeds</span>
          <SidebarUnreadToggle unreadOnly={sidebarUnreadOnly} onToggle={toggleSidebarUnreadOnly} />
        </div>

        {/* Scrollable area with tags and feeds */}
        <div className="flex-1 overflow-y-auto p-3">
          <TagList
            onNavigate={handleNavigate}
            onEdit={handleEdit}
            onUnsubscribe={handleUnsubscribe}
            unreadOnly={sidebarUnreadOnly}
            onPrefetch={handlePrefetchRoute}
          />
        </div>
      </nav>

      {/* Unsubscribe Confirmation Dialog */}
      <UnsubscribeDialog
        isOpen={unsubscribeTarget !== null}
        feedTitle={unsubscribeTarget?.title ?? ""}
        isLoading={unsubscribeMutation.isPending}
        onConfirm={() => {
          if (unsubscribeTarget) {
            unsubscribeMutation.mutate({ id: unsubscribeTarget.id });
          }
        }}
        onCancel={() => setUnsubscribeTarget(null)}
      />

      {/* Edit Subscription Dialog */}
      <EditSubscriptionDialog
        isOpen={editTarget !== null}
        subscriptionId={editTarget?.id ?? ""}
        currentTitle={editTarget?.title ?? ""}
        currentCustomTitle={editTarget?.customTitle ?? null}
        currentTagIds={editTarget?.tagIds ?? []}
        onClose={() => {
          setEditTarget(null);
          utils.subscriptions.list.invalidate();
          utils.tags.list.invalidate();
        }}
      />
    </>
  );
}
