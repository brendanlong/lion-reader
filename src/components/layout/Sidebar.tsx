/**
 * Sidebar Component
 *
 * Navigation sidebar for the main app layout.
 * Shows navigation links, feed list with unread counts, and tags.
 */

"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { getViewPreferences, useViewPreferences, useExpandedTags } from "@/lib/hooks";
import { UnsubscribeDialog } from "@/components/feeds/UnsubscribeDialog";
import { EditSubscriptionDialog } from "@/components/feeds/EditSubscriptionDialog";

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
  const starredCountQuery = trpc.entries.starredCount.useQuery({});
  const utils = trpc.useUtils();

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
          items: oldData.items.filter((item) => item.subscription.id !== variables.id),
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

  // Get view preferences for prefetching with correct filters
  const allPrefs = useViewPreferences("all");
  const starredPrefs = useViewPreferences("starred");
  const savedPrefs = useViewPreferences("saved");

  // Prefetch entry list on mousedown for faster navigation
  const prefetchEntryList = useCallback(
    (options: {
      feedId?: string;
      tagId?: string;
      type?: "saved";
      starredOnly?: boolean;
      uncategorized?: boolean;
      unreadOnly?: boolean;
      sortOrder?: "newest" | "oldest";
    }) => {
      utils.entries.list.prefetchInfinite(
        {
          feedId: options.feedId,
          tagId: options.tagId,
          type: options.type,
          starredOnly: options.starredOnly,
          uncategorized: options.uncategorized,
          unreadOnly: options.unreadOnly,
          sortOrder: options.sortOrder,
          limit: 20,
        },
        {
          pages: 1,
          getNextPageParam: (lastPage) => lastPage.nextCursor,
        }
      );
    },
    [utils]
  );

  // Mousedown handlers for prefetching
  const handleAllMouseDown = useCallback(() => {
    prefetchEntryList({
      unreadOnly: allPrefs.showUnreadOnly,
      sortOrder: allPrefs.sortOrder,
    });
  }, [prefetchEntryList, allPrefs.showUnreadOnly, allPrefs.sortOrder]);

  const handleStarredMouseDown = useCallback(() => {
    prefetchEntryList({
      starredOnly: true,
      unreadOnly: starredPrefs.showUnreadOnly,
      sortOrder: starredPrefs.sortOrder,
    });
  }, [prefetchEntryList, starredPrefs.showUnreadOnly, starredPrefs.sortOrder]);

  const handleSavedMouseDown = useCallback(() => {
    prefetchEntryList({
      type: "saved",
      unreadOnly: savedPrefs.showUnreadOnly,
      sortOrder: savedPrefs.sortOrder,
    });
  }, [prefetchEntryList, savedPrefs.showUnreadOnly, savedPrefs.sortOrder]);

  const handleFeedMouseDown = useCallback(
    (feedId: string) => {
      // Use sync function for per-feed preferences (can't call hooks in callbacks)
      const prefs = getViewPreferences("feed", feedId);
      prefetchEntryList({
        feedId,
        unreadOnly: prefs.showUnreadOnly,
        sortOrder: prefs.sortOrder,
      });
    },
    [prefetchEntryList]
  );

  const handleTagMouseDown = useCallback(
    (tagId: string) => {
      // Use sync function for per-tag preferences (can't call hooks in callbacks)
      const prefs = getViewPreferences("tag", tagId);
      prefetchEntryList({
        tagId,
        unreadOnly: prefs.showUnreadOnly,
        sortOrder: prefs.sortOrder,
      });
    },
    [prefetchEntryList]
  );

  const handleUncategorizedMouseDown = useCallback(() => {
    const prefs = getViewPreferences("uncategorized");
    prefetchEntryList({
      uncategorized: true,
      unreadOnly: prefs.showUnreadOnly,
      sortOrder: prefs.sortOrder,
    });
  }, [prefetchEntryList]);

  // Calculate total unread count (subscriptions + saved articles)
  const totalUnreadCount =
    (subscriptionsQuery.data?.items.reduce((sum, item) => sum + item.subscription.unreadCount, 0) ??
      0) + (savedCountQuery.data?.unread ?? 0);

  // Hook for managing tag expansion state
  const { isExpanded, toggleExpanded } = useExpandedTags();

  // Group subscriptions by tag
  const subscriptionsByTag = useMemo(() => {
    type SubscriptionItem = NonNullable<typeof subscriptionsQuery.data>["items"][number];
    const byTag = new Map<string, SubscriptionItem[]>();
    const uncategorized: SubscriptionItem[] = [];

    for (const item of subscriptionsQuery.data?.items ?? []) {
      if (item.subscription.tags.length === 0) {
        uncategorized.push(item);
      } else {
        for (const tag of item.subscription.tags) {
          const existing = byTag.get(tag.id) ?? [];
          existing.push(item);
          byTag.set(tag.id, existing);
        }
      }
    }

    return { byTag, uncategorized };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionsQuery.data]);

  // Sort tags alphabetically and filter out empty ones (tags with no subscriptions)
  const sortedTags = useMemo(() => {
    return [...(tagsQuery.data?.items ?? [])]
      .filter((tag) => subscriptionsByTag.byTag.has(tag.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [tagsQuery.data?.items, subscriptionsByTag.byTag]);

  // Compute uncategorized stats
  const uncategorizedUnreadCount = useMemo(() => {
    return subscriptionsByTag.uncategorized.reduce(
      (sum, item) => sum + item.subscription.unreadCount,
      0
    );
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
          <Link
            href="/all"
            onClick={handleClose}
            onMouseDown={handleAllMouseDown}
            className={`flex min-h-[44px] items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isActiveLink("/all")
                ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            <span>All Items</span>
            {totalUnreadCount > 0 && (
              <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                ({totalUnreadCount})
              </span>
            )}
          </Link>

          <Link
            href="/starred"
            onClick={handleClose}
            onMouseDown={handleStarredMouseDown}
            className={`flex min-h-[44px] items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isActiveLink("/starred")
                ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            <span>Starred</span>
            {starredCountQuery.data && starredCountQuery.data.unread > 0 && (
              <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                ({starredCountQuery.data.unread})
              </span>
            )}
          </Link>

          <Link
            href="/saved"
            onClick={handleClose}
            onMouseDown={handleSavedMouseDown}
            className={`flex min-h-[44px] items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isActiveLink("/saved")
                ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            <span>Saved</span>
            {savedCountQuery.data && savedCountQuery.data.unread > 0 && (
              <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                ({savedCountQuery.data.unread})
              </span>
            )}
          </Link>
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
            <p className="px-3 text-sm text-red-600 dark:text-red-400">Failed to load feeds</p>
          ) : subscriptionsQuery.data?.items.length === 0 ? (
            <p className="px-3 text-sm text-zinc-500 dark:text-zinc-400">
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
                        {expanded ? (
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 9l-7 7-7-7"
                            />
                          </svg>
                        ) : (
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 5l7 7-7 7"
                            />
                          </svg>
                        )}
                      </button>

                      {/* Tag link */}
                      <Link
                        href={tagHref}
                        onClick={handleClose}
                        onMouseDown={() => handleTagMouseDown(tag.id)}
                        className={`flex min-h-[44px] flex-1 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                          isActive
                            ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                            : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        }`}
                      >
                        <span
                          className="inline-block h-3 w-3 shrink-0 rounded-full"
                          style={{ backgroundColor: tag.color || "#6b7280" }}
                          aria-hidden="true"
                        />
                        <span className="truncate">{tag.name}</span>
                        {tag.unreadCount > 0 && (
                          <span className="ml-auto shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                            ({tag.unreadCount})
                          </span>
                        )}
                      </Link>
                    </div>

                    {/* Nested feeds (when expanded) */}
                    {expanded && (
                      <ul className="mt-1 ml-6 space-y-1">
                        {tagFeeds.map(({ subscription, feed }) => {
                          const title = subscription.customTitle || feed.title || "Untitled Feed";
                          const feedHref = `/feed/${feed.id}`;
                          const isFeedActive = pathname === feedHref;

                          return (
                            <li key={subscription.id} className="group relative">
                              <Link
                                href={feedHref}
                                prefetch={false}
                                onClick={handleClose}
                                onMouseDown={() => handleFeedMouseDown(feed.id)}
                                className={`flex min-h-[44px] items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
                                  isFeedActive
                                    ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                                    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                                }`}
                              >
                                <span className="truncate pr-8">{title}</span>
                                {subscription.unreadCount > 0 && (
                                  <span className="shrink-0 text-xs text-zinc-500 group-hover:hidden dark:text-zinc-400">
                                    ({subscription.unreadCount})
                                  </span>
                                )}
                              </Link>

                              {/* Action buttons - visible on hover/touch */}
                              <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                                {/* Edit button */}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditTarget({
                                      id: subscription.id,
                                      title,
                                      customTitle: subscription.customTitle,
                                      tagIds: subscription.tags.map((t) => t.id),
                                    });
                                  }}
                                  className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
                                  title="Edit subscription"
                                  aria-label={`Edit ${title}`}
                                >
                                  <svg
                                    className="h-3.5 w-3.5"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2}
                                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                    />
                                  </svg>
                                </button>

                                {/* Unsubscribe button */}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setUnsubscribeTarget({
                                      id: subscription.id,
                                      title,
                                    });
                                  }}
                                  className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
                                  title="Unsubscribe"
                                  aria-label={`Unsubscribe from ${title}`}
                                >
                                  <svg
                                    className="h-3.5 w-3.5"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2}
                                      d="M6 18L18 6M6 6l12 12"
                                    />
                                  </svg>
                                </button>
                              </div>
                            </li>
                          );
                        })}
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
                      {isExpanded("uncategorized") ? (
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 9l-7 7-7-7"
                          />
                        </svg>
                      ) : (
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      )}
                    </button>

                    {/* Uncategorized link */}
                    <Link
                      href="/uncategorized"
                      onClick={handleClose}
                      onMouseDown={handleUncategorizedMouseDown}
                      className={`flex min-h-[44px] flex-1 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                        isActiveLink("/uncategorized")
                          ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                          : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      }`}
                    >
                      <span
                        className="inline-block h-3 w-3 shrink-0 rounded-full"
                        style={{ backgroundColor: "#6b7280" }}
                        aria-hidden="true"
                      />
                      <span className="truncate">Uncategorized</span>
                      {uncategorizedUnreadCount > 0 && (
                        <span className="ml-auto shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                          ({uncategorizedUnreadCount})
                        </span>
                      )}
                    </Link>
                  </div>

                  {/* Nested uncategorized feeds (when expanded) */}
                  {isExpanded("uncategorized") && (
                    <ul className="mt-1 ml-6 space-y-1">
                      {subscriptionsByTag.uncategorized.map(({ subscription, feed }) => {
                        const title = subscription.customTitle || feed.title || "Untitled Feed";
                        const feedHref = `/feed/${feed.id}`;
                        const isFeedActive = pathname === feedHref;

                        return (
                          <li key={subscription.id} className="group relative">
                            <Link
                              href={feedHref}
                              prefetch={false}
                              onClick={handleClose}
                              onMouseDown={() => handleFeedMouseDown(feed.id)}
                              className={`flex min-h-[44px] items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
                                isFeedActive
                                  ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                                  : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                              }`}
                            >
                              <span className="truncate pr-8">{title}</span>
                              {subscription.unreadCount > 0 && (
                                <span className="shrink-0 text-xs text-zinc-500 group-hover:hidden dark:text-zinc-400">
                                  ({subscription.unreadCount})
                                </span>
                              )}
                            </Link>

                            {/* Action buttons - visible on hover/touch */}
                            <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                              {/* Edit button */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditTarget({
                                    id: subscription.id,
                                    title,
                                    customTitle: subscription.customTitle,
                                    tagIds: subscription.tags.map((t) => t.id),
                                  });
                                }}
                                className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
                                title="Edit subscription"
                                aria-label={`Edit ${title}`}
                              >
                                <svg
                                  className="h-3.5 w-3.5"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                  />
                                </svg>
                              </button>

                              {/* Unsubscribe button */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setUnsubscribeTarget({
                                    id: subscription.id,
                                    title,
                                  });
                                }}
                                className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
                                title="Unsubscribe"
                                aria-label={`Unsubscribe from ${title}`}
                              >
                                <svg
                                  className="h-3.5 w-3.5"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                  />
                                </svg>
                              </button>
                            </div>
                          </li>
                        );
                      })}
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
