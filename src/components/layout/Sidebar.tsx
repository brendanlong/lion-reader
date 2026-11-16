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
import { useAppPathname } from "@/lib/hooks/useAppLocation";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { useUnsubscribeMutation } from "@/lib/hooks/useUnsubscribeMutation";
import { refreshEntryLists } from "@/lib/hooks/useEntryListRefreshOnNavigate";
import { entriesListInputFor } from "@/lib/queries/entries-list-input";
import { UnsubscribeDialog } from "@/components/feeds/UnsubscribeDialog";
import { EditSubscriptionDialog } from "@/components/feeds/EditSubscriptionDialog";
import { useSidebarUnreadOnly } from "@/lib/hooks/useSidebarUnreadOnly";
import { SidebarNav } from "./SidebarNav";
import { TagList } from "./TagList";
import { ScrollContainer } from "./ScrollContainerContext";
import { StateToggleButton } from "@/components/ui/state-toggle-button";
import { EyeIcon, EyeSlashIcon } from "@/components/ui/icons";
import { untitledSubscriptionLabel } from "@/lib/collections";
import type { SubscriptionRow } from "@/lib/local-db/subscriptions";

interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const queryClient = useQueryClient();
  const pathname = useAppPathname();
  const { sidebarUnreadOnly, toggleSidebarUnreadOnly } = useSidebarUnreadOnly();
  const [unsubscribeTarget, setUnsubscribeTarget] = useState<SubscriptionRow | null>(null);
  const [editTarget, setEditTarget] = useState<SubscriptionRow | null>(null);

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
  const handlePrefetchRoute = useCallback(
    (href: string) => {
      const input = entriesListInputFor(href, new URLSearchParams());
      void utils.entries.list.prefetchInfinite(input, {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        pages: 1,
      });
    },
    [utils]
  );

  return (
    <>
      <nav className="bg-surface flex h-full flex-col">
        {/* Main Navigation with streaming counts */}
        <SidebarNav onNavigate={handleNavigate} onPrefetch={handlePrefetchRoute} />

        {/* Divider with unread toggle */}
        <div className="border-edge-strong mx-3 flex items-center gap-2 border-t pt-2">
          <span className="ui-text-xs text-muted flex-1 font-medium">Feeds</span>
          <StateToggleButton
            icon={
              sidebarUnreadOnly ? (
                <EyeSlashIcon className="h-5 w-5" />
              ) : (
                <EyeIcon className="h-5 w-5" />
              )
            }
            name="Unread feeds only"
            isPressed={sidebarUnreadOnly}
            onToggle={toggleSidebarUnreadOnly}
          />
        </div>

        {/* Scrollable area with tags and feeds */}
        <ScrollContainer className="flex-1 overflow-y-auto p-3">
          <TagList
            onNavigate={handleNavigate}
            onEdit={setEditTarget}
            onUnsubscribe={setUnsubscribeTarget}
            unreadOnly={sidebarUnreadOnly}
            onPrefetch={handlePrefetchRoute}
          />
        </ScrollContainer>
      </nav>

      {/* Unsubscribe Confirmation Dialog */}
      <UnsubscribeDialog
        isOpen={unsubscribeTarget !== null}
        feedTitle={
          unsubscribeTarget
            ? unsubscribeTarget.title || untitledSubscriptionLabel(unsubscribeTarget.type)
            : ""
        }
        isCollection={unsubscribeTarget?.type === "collection"}
        emailSubscriptionId={unsubscribeTarget?.type === "email" ? unsubscribeTarget.id : undefined}
        isLoading={unsubscribeMutation.isPending}
        onConfirm={(options) => {
          if (unsubscribeTarget) {
            unsubscribeMutation.mutate({ id: unsubscribeTarget.id, ...options });
          }
        }}
        onCancel={() => setUnsubscribeTarget(null)}
      />

      {/* Edit Subscription Dialog */}
      {editTarget && (
        <EditSubscriptionDialog subscription={editTarget} onClose={() => setEditTarget(null)} />
      )}
    </>
  );
}
