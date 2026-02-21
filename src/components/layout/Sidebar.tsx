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
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { useCollections } from "@/lib/collections/context";
import { handleSubscriptionDeleted, refreshGlobalCounts } from "@/lib/cache/operations";
import dynamic from "next/dynamic";
import { UnsubscribeDialog } from "@/components/feeds/UnsubscribeDialog";
import { EditSubscriptionDialog } from "@/components/feeds/EditSubscriptionDialog";
import { useSidebarUnreadOnly } from "@/lib/hooks/useSidebarUnreadOnly";
import { TagList } from "./TagList";
import { SidebarUnreadToggle } from "./SidebarUnreadToggle";

// SidebarNav uses useLiveQuery (TanStack DB) which calls useSyncExternalStore
// without getServerSnapshot, causing SSR to crash. Disable SSR for this component
// since the counts collection is client-only state anyway.
const SidebarNav = dynamic(() => import("./SidebarNav").then((m) => m.SidebarNav), {
  ssr: false,
  loading: () => <SidebarNavSkeleton />,
});

/**
 * Skeleton placeholder matching SidebarNav's layout (3 nav links).
 */
function SidebarNavSkeleton() {
  return (
    <div className="space-y-1 p-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-9 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800" />
      ))}
    </div>
  );
}

interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const collections = useCollections();
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
      // Use centralized cache operation for optimistic removal (dual-write to collections)
      handleSubscriptionDeleted(utils, variables.id, collections);
    },
    onError: () => {
      toast.error("Failed to unsubscribe from feed");
      // On error, invalidate to refetch correct state.
      // Subscription infinite queries will re-populate the subscriptions collection.
      utils.subscriptions.list.invalidate();
      utils.tags.list.invalidate();
      collections.tags.utils.refetch();
      refreshGlobalCounts(utils, collections);
    },
  });

  const handleNavigate = () => {
    // Invalidate the view collection so the entry list refetches.
    // This ensures clicking the current page's link refreshes the list,
    // while cross-page navigation also works (new collection creates on mount).
    collections.invalidateActiveView();
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
