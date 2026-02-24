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
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { handleSubscriptionDeleted } from "@/lib/cache/operations";
import { getFiltersFromPathname } from "@/lib/hooks/useEntriesListInput";
import { buildEntriesListInput } from "@/lib/queries/entries-list-input";
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

  const unsubscribeMutation = trpc.subscriptions.delete.useMutation({
    onMutate: async (variables) => {
      // Close dialog immediately for responsive feel
      setUnsubscribeTarget(null);
      // Use centralized cache operation for optimistic removal
      handleSubscriptionDeleted(utils, variables.id, queryClient);
    },
    onError: () => {
      toast.error("Failed to unsubscribe from feed");
      // On error, invalidate to refetch correct state
      utils.subscriptions.list.invalidate();
      utils.tags.list.invalidate();
      utils.entries.count.invalidate();
    },
  });

  const handleNavigate = () => {
    // Mark entry list queries as stale and refetch active ones.
    // This ensures clicking the current page's link refreshes the list,
    // while cross-page navigation also works (new query fetches on mount).
    queryClient.invalidateQueries({
      queryKey: [["entries", "list"]],
    });
    onClose?.();
  };

  // Prefetch entries.list on mousedown (fires ~100-200ms before click).
  // Even though handleNavigate invalidates the cache, prefetched data will
  // still be available as stale data - useSuspenseInfiniteQuery renders stale
  // data immediately without suspending, then refetches in the background.
  const handlePrefetchRoute = useCallback(
    (href: string) => {
      const filters = getFiltersFromPathname(href);
      const defaultUnreadOnly = href === "/recently-read" ? false : true;
      const input = buildEntriesListInput(filters, {
        unreadOnly: defaultUnreadOnly,
        sortOrder: "newest",
      });
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
      <nav className="flex h-full flex-col bg-white dark:bg-zinc-900">
        {/* Main Navigation with streaming counts */}
        <SidebarNav onNavigate={handleNavigate} onPrefetch={handlePrefetchRoute} />

        {/* Divider with unread toggle */}
        <div className="mx-3 flex items-center gap-2 border-t border-zinc-200 pt-2 dark:border-zinc-700">
          <span className="ui-text-xs flex-1 font-medium text-zinc-500 dark:text-zinc-400">
            Feeds
          </span>
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
