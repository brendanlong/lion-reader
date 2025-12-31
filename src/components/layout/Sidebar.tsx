/**
 * Sidebar Component
 *
 * Navigation sidebar for the main app layout.
 * Shows navigation links, feed list with unread counts, and tags.
 */

"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
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
    onSuccess: () => {
      utils.subscriptions.list.invalidate();
      utils.entries.list.invalidate();
      setUnsubscribeTarget(null);
    },
    onError: () => {
      toast.error("Failed to unsubscribe from feed");
    },
  });

  // Calculate total unread count (subscriptions + saved articles)
  const totalUnreadCount =
    (subscriptionsQuery.data?.items.reduce((sum, item) => sum + item.subscription.unreadCount, 0) ??
      0) + (savedCountQuery.data?.unread ?? 0);

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
    if (href.startsWith("/tag/")) {
      return pathname === href;
    }
    return pathname.startsWith(href);
  };

  // Get tag data for easy lookup
  const tags = tagsQuery.data?.items ?? [];

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

        {/* Feeds Section */}
        <div className="flex-1 overflow-y-auto p-3">
          <h3 className="mb-2 px-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
            Feeds
          </h3>

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
              {subscriptionsQuery.data?.items.map(({ subscription, feed }) => {
                const title = subscription.customTitle || feed.title || "Untitled Feed";
                const feedHref = `/feed/${feed.id}`;
                const isActive = pathname === feedHref;
                const subscriptionTags = subscription.tags || [];

                return (
                  <li key={subscription.id} className="group relative">
                    <Link
                      href={feedHref}
                      onClick={handleClose}
                      className={`flex min-h-[44px] items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
                        isActive
                          ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                          : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      }`}
                    >
                      <span className="flex items-center gap-2 truncate pr-8">
                        {/* Tag color dots */}
                        {subscriptionTags.length > 0 && (
                          <span className="flex shrink-0 gap-0.5">
                            {subscriptionTags.slice(0, 3).map((tag) => (
                              <span
                                key={tag.id}
                                className="inline-block h-2 w-2 rounded-full"
                                style={{ backgroundColor: tag.color || "#6b7280" }}
                                title={tag.name}
                              />
                            ))}
                            {subscriptionTags.length > 3 && (
                              <span className="text-xs text-zinc-400">
                                +{subscriptionTags.length - 3}
                              </span>
                            )}
                          </span>
                        )}
                        <span className="truncate">{title}</span>
                      </span>
                      {subscription.unreadCount > 0 && (
                        <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                          ({subscription.unreadCount})
                        </span>
                      )}
                    </Link>

                    {/* Action buttons - visible on hover/touch */}
                    <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 lg:opacity-0">
                      {/* Edit button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditTarget({
                            id: subscription.id,
                            title,
                            customTitle: subscription.customTitle,
                            tagIds: subscriptionTags.map((t) => t.id),
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
        </div>

        {/* Tags Section */}
        {tags.length > 0 && (
          <>
            {/* Divider */}
            <div className="mx-3 border-t border-zinc-200 dark:border-zinc-700" />

            <div className="flex-shrink-0 p-3">
              <h3 className="mb-2 px-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
                Tags
              </h3>

              <ul className="space-y-1">
                {tags.map((tag) => {
                  const tagHref = `/tag/${tag.id}`;
                  const isActive = isActiveLink(tagHref);

                  return (
                    <li key={tag.id}>
                      <Link
                        href={tagHref}
                        onClick={handleClose}
                        className={`flex min-h-[40px] items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
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
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}
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
