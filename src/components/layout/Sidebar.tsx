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

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { useCollections } from "@/lib/collections/context";
import { handleSubscriptionDeleted } from "@/lib/cache/operations";
import { UnsubscribeDialog } from "@/components/feeds/UnsubscribeDialog";
import { EditSubscriptionDialog } from "@/components/feeds/EditSubscriptionDialog";
import { SidebarNav } from "./SidebarNav";
import { TagList } from "./TagList";

interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const queryClient = useQueryClient();
  const collections = useCollections();
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
      // Use centralized cache operation for optimistic removal (dual-write to collections)
      handleSubscriptionDeleted(utils, variables.id, queryClient, collections);
    },
    onError: () => {
      toast.error("Failed to unsubscribe from feed");
      // On error, invalidate to refetch correct state.
      // Subscription infinite queries will re-populate the subscriptions collection.
      utils.subscriptions.list.invalidate();
      utils.tags.list.invalidate();
      utils.entries.count.invalidate();
      collections.tags.utils.refetch();
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
        <SidebarNav onNavigate={handleNavigate} />

        {/* Divider */}
        <div className="mx-3 border-t border-zinc-200 dark:border-zinc-700" />

        {/* Scrollable area with tags and feeds */}
        <div className="flex-1 overflow-y-auto p-3">
          <TagList
            onNavigate={handleNavigate}
            onEdit={handleEdit}
            onUnsubscribe={handleUnsubscribe}
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
          // Invalidate subscription queries to refetch with new data.
          // Subscription infinite queries will re-populate the subscriptions collection.
          utils.subscriptions.list.invalidate();
          utils.tags.list.invalidate();
          collections.tags.utils.refetch();
        }}
      />
    </>
  );
}
