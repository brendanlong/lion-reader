/**
 * Sidebar Component
 *
 * Navigation sidebar for the main app layout.
 * Shows navigation links, feed list with unread counts, and tags.
 *
 * Uses tags.list for the tag structure and entries.count for All Articles unread count.
 * Subscriptions are loaded per-tag via TagSubscriptionList when a tag is expanded.
 */

"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { useExpandedTags } from "@/lib/hooks";
import { UnsubscribeDialog } from "@/components/feeds/UnsubscribeDialog";
import { EditSubscriptionDialog } from "@/components/feeds/EditSubscriptionDialog";
import {
  NavLink,
  NavLinkWithIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ColorDot,
} from "@/components/ui";
import { TagSubscriptionList } from "./TagSubscriptionList";

interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const pathname = usePathname();
  const queryClient = useQueryClient();
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

  const tagsQuery = trpc.tags.list.useQuery();
  // Use entries.count for All Articles unread count (server-side, not client-side sum)
  const allCountQuery = trpc.entries.count.useQuery({});
  // Use unified entries.count with type='saved' filter
  const savedCountQuery = trpc.entries.count.useQuery({ type: "saved" });
  // Use unified entries.count with starredOnly filter
  const starredCountQuery = trpc.entries.count.useQuery({ starredOnly: true });
  const utils = trpc.useUtils();

  // Use tag data directly
  const tags = tagsQuery.data?.items;
  const uncategorized = tagsQuery.data?.uncategorized;

  const unsubscribeMutation = trpc.subscriptions.delete.useMutation({
    onMutate: async () => {
      // Close dialog immediately for responsive feel
      setUnsubscribeTarget(null);
    },
    onError: () => {
      toast.error("Failed to unsubscribe from feed");
    },
    onSettled: () => {
      // Invalidate all subscription queries (per-tag infinite queries)
      utils.subscriptions.list.invalidate();
      // Invalidate entries and tags to update counts
      utils.entries.list.invalidate();
      utils.entries.count.invalidate();
      utils.tags.list.invalidate();
    },
  });

  // All Articles unread count from server
  const totalUnreadCount = allCountQuery.data?.unread ?? 0;

  // Saved unread count
  const savedUnreadCount = savedCountQuery.data?.unread ?? 0;

  // Hook for managing tag expansion state
  const { isExpanded, toggleExpanded } = useExpandedTags();

  // Tags sorted alphabetically, showing only tags that have subscriptions
  const sortedTags = [...(tags ?? [])]
    .filter((tag) => tag.feedCount > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const hasUncategorized = (uncategorized?.feedCount ?? 0) > 0;

  const isActiveLink = (href: string) => {
    if (href === "/all") {
      return pathname === "/all";
    }
    if (href === "/starred") {
      return pathname === "/starred";
    }
    if (href === "/saved") {
      return pathname === "/saved";
    }
    if (href === "/uncategorized") {
      return pathname === "/uncategorized";
    }
    if (href.startsWith("/tag/")) {
      return pathname === href;
    }
    return pathname.startsWith(href);
  };

  const handleClose = () => {
    // Mark entry list queries as stale so they refetch when mounted
    // Use refetchType: 'none' to avoid refetching the current (soon-to-be-unmounted) query
    // The new view's query will refetch on mount because it's now stale
    queryClient.invalidateQueries({
      queryKey: [["entries", "list"]],
      refetchType: "none",
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

  const hasTags = sortedTags.length > 0 || hasUncategorized;

  return (
    <>
      <nav className="flex h-full flex-col bg-white dark:bg-zinc-900">
        {/* Main Navigation */}
        <div className="space-y-1 p-3">
          <NavLink
            href="/all"
            isActive={isActiveLink("/all")}
            count={totalUnreadCount}
            onClick={handleClose}
          >
            All Items
          </NavLink>

          <NavLink
            href="/starred"
            isActive={isActiveLink("/starred")}
            count={starredCountQuery.data?.unread}
            onClick={handleClose}
          >
            Starred
          </NavLink>

          <NavLink
            href="/saved"
            isActive={isActiveLink("/saved")}
            count={savedUnreadCount}
            onClick={handleClose}
          >
            Saved
          </NavLink>
        </div>

        {/* Divider */}
        <div className="mx-3 border-t border-zinc-200 dark:border-zinc-700" />

        {/* Scrollable area with tags and feeds */}
        <div className="flex-1 overflow-y-auto p-3">
          {tagsQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-9 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800"
                />
              ))}
            </div>
          ) : tagsQuery.error ? (
            <p className="ui-text-sm px-3 text-red-600 dark:text-red-400">Failed to load feeds</p>
          ) : !hasTags ? (
            <p className="ui-text-sm px-3 text-zinc-500 dark:text-zinc-400">
              No subscriptions yet.{" "}
              <Link
                href="/subscribe"
                onClick={handleClose}
                className="text-zinc-900 underline dark:text-zinc-50"
              >
                Add one
              </Link>
            </p>
          ) : (
            <ul className="space-y-1">
              {/* Tags with nested feeds */}
              {sortedTags.map((tag) => {
                const tagHref = `/tag/${tag.id}`;
                const isActive = isActiveLink(tagHref);
                const expanded = isExpanded(tag.id);

                return (
                  <li key={tag.id}>
                    {/* Tag row */}
                    <div className="flex min-h-[44px] items-center">
                      {/* Chevron button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpanded(tag.id);
                        }}
                        className="flex h-6 w-6 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
                        aria-label={expanded ? "Collapse" : "Expand"}
                      >
                        {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                      </button>

                      {/* Tag link */}
                      <NavLinkWithIcon
                        href={tagHref}
                        isActive={isActive}
                        icon={<ColorDot color={tag.color} size="sm" />}
                        label={tag.name}
                        count={tag.unreadCount}
                        onClick={handleClose}
                      />
                    </div>

                    {/* Nested feeds (when expanded) - loaded per-tag */}
                    {expanded && (
                      <TagSubscriptionList
                        tagId={tag.id}
                        pathname={pathname}
                        onClose={handleClose}
                        onEdit={handleEdit}
                        onUnsubscribe={handleUnsubscribe}
                      />
                    )}
                  </li>
                );
              })}

              {/* Uncategorized section (only if there are uncategorized feeds) */}
              {hasUncategorized && (
                <li>
                  {/* Uncategorized row */}
                  <div className="flex min-h-[44px] items-center">
                    {/* Chevron button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpanded("uncategorized");
                      }}
                      className="flex h-6 w-6 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
                      aria-label={isExpanded("uncategorized") ? "Collapse" : "Expand"}
                    >
                      {isExpanded("uncategorized") ? <ChevronDownIcon /> : <ChevronRightIcon />}
                    </button>

                    {/* Uncategorized link */}
                    <NavLinkWithIcon
                      href="/uncategorized"
                      isActive={isActiveLink("/uncategorized")}
                      icon={<ColorDot color={null} size="sm" />}
                      label="Uncategorized"
                      count={uncategorized?.unreadCount ?? 0}
                      onClick={handleClose}
                    />
                  </div>

                  {/* Nested uncategorized feeds (when expanded) */}
                  {isExpanded("uncategorized") && (
                    <TagSubscriptionList
                      uncategorized
                      pathname={pathname}
                      onClose={handleClose}
                      onEdit={handleEdit}
                      onUnsubscribe={handleUnsubscribe}
                    />
                  )}
                </li>
              )}
            </ul>
          )}
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
