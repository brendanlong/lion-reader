/**
 * Sidebar Component
 *
 * Navigation sidebar for the main app layout.
 * Shows navigation links, feed list with unread counts, and tags.
 */

"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
import { SubscriptionItem } from "./SubscriptionItem";

interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const pathname = usePathname();
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

  const subscriptionsQuery = trpc.subscriptions.list.useQuery();
  const tagsQuery = trpc.tags.list.useQuery();
  // Use unified entries.count with type='saved' filter
  const savedCountQuery = trpc.entries.count.useQuery({ type: "saved" });
  // Use unified entries.count with starredOnly filter
  const starredCountQuery = trpc.entries.count.useQuery({ starredOnly: true });
  const utils = trpc.useUtils();

  // Use subscription data directly (no delta merging)
  const subscriptions = subscriptionsQuery.data?.items;

  // Use tag data directly (no delta merging)
  const tags = tagsQuery.data?.items;

  const unsubscribeMutation = trpc.subscriptions.delete.useMutation({
    onMutate: async (variables) => {
      // Close dialog immediately for responsive feel
      setUnsubscribeTarget(null);

      // Cancel in-flight queries to prevent race conditions
      await utils.subscriptions.list.cancel();

      // Snapshot current state for rollback
      const previousData = utils.subscriptions.list.getData();

      // Optimistically remove the subscription from the list
      utils.subscriptions.list.setData(undefined, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          items: oldData.items.filter((item) => item.id !== variables.id),
        };
      });

      return { previousData };
    },
    onError: (_error, _variables, context) => {
      // Rollback on error
      if (context?.previousData) {
        utils.subscriptions.list.setData(undefined, context.previousData);
      }
      toast.error("Failed to unsubscribe from feed");
    },
    onSettled: (_data, error) => {
      // Only invalidate on error since optimistic update handles the success case
      // The SSE handler will also skip invalidation since the subscription is already removed
      if (error) {
        utils.subscriptions.list.invalidate();
      }
      // Invalidate entries and tags to update counts (entries from unsubscribed feed
      // are filtered out by the query, tags need updated unread counts)
      utils.entries.list.invalidate();
      utils.tags.list.invalidate();
    },
  });

  // Calculate saved unread count directly from query
  const savedUnreadCount = savedCountQuery.data?.unread ?? 0;

  // Calculate total unread count (subscriptions + saved articles)
  const totalUnreadCount =
    (subscriptions?.reduce((sum, item) => sum + item.unreadCount, 0) ?? 0) + savedUnreadCount;

  // Hook for managing tag expansion state
  const { isExpanded, toggleExpanded } = useExpandedTags();

  // Group subscriptions by tag
  const subscriptionsByTag = useMemo(() => {
    type SubscriptionItem = NonNullable<typeof subscriptions>[number];
    const byTag = new Map<string, SubscriptionItem[]>();
    const uncategorized: SubscriptionItem[] = [];

    for (const item of subscriptions ?? []) {
      if (item.tags.length === 0) {
        uncategorized.push(item);
      } else {
        for (const tag of item.tags) {
          const existing = byTag.get(tag.id) ?? [];
          existing.push(item);
          byTag.set(tag.id, existing);
        }
      }
    }

    return { byTag, uncategorized };
  }, [subscriptions]);

  // Sort tags alphabetically and filter out empty ones
  const sortedTags = useMemo(() => {
    return [...(tags ?? [])]
      .filter((tag) => subscriptionsByTag.byTag.has(tag.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [tags, subscriptionsByTag.byTag]);

  // Compute uncategorized stats
  const uncategorizedUnreadCount = useMemo(() => {
    return subscriptionsByTag.uncategorized.reduce((sum, item) => sum + item.unreadCount, 0);
  }, [subscriptionsByTag.uncategorized]);

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
    onClose?.();
  };

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
          {subscriptionsQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-9 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800"
                />
              ))}
            </div>
          ) : subscriptionsQuery.error ? (
            <p className="ui-text-sm px-3 text-red-600 dark:text-red-400">Failed to load feeds</p>
          ) : subscriptionsQuery.data?.items.length === 0 ? (
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
                const tagFeeds = subscriptionsByTag.byTag.get(tag.id) ?? [];

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

                    {/* Nested feeds (when expanded) */}
                    {expanded && (
                      <ul className="mt-1 ml-6 space-y-1">
                        {tagFeeds.map((sub) => (
                          <SubscriptionItem
                            key={sub.id}
                            subscription={sub}
                            isActive={pathname === `/subscription/${sub.id}`}
                            onClose={handleClose}
                            onEdit={() =>
                              setEditTarget({
                                id: sub.id,
                                title: sub.title || "Untitled Feed",
                                customTitle: sub.title !== sub.originalTitle ? sub.title : null,
                                tagIds: sub.tags.map((t) => t.id),
                              })
                            }
                            onUnsubscribe={() =>
                              setUnsubscribeTarget({
                                id: sub.id,
                                title: sub.title || "Untitled Feed",
                              })
                            }
                          />
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}

              {/* Uncategorized section (only if there are uncategorized feeds) */}
              {subscriptionsByTag.uncategorized.length > 0 && (
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
                      count={uncategorizedUnreadCount}
                      onClick={handleClose}
                    />
                  </div>

                  {/* Nested uncategorized feeds (when expanded) */}
                  {isExpanded("uncategorized") && (
                    <ul className="mt-1 ml-6 space-y-1">
                      {subscriptionsByTag.uncategorized.map((sub) => (
                        <SubscriptionItem
                          key={sub.id}
                          subscription={sub}
                          isActive={pathname === `/subscription/${sub.id}`}
                          onClose={handleClose}
                          onEdit={() =>
                            setEditTarget({
                              id: sub.id,
                              title: sub.title || "Untitled Feed",
                              customTitle: sub.title !== sub.originalTitle ? sub.title : null,
                              tagIds: sub.tags.map((t) => t.id),
                            })
                          }
                          onUnsubscribe={() =>
                            setUnsubscribeTarget({
                              id: sub.id,
                              title: sub.title || "Untitled Feed",
                            })
                          }
                        />
                      ))}
                    </ul>
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
