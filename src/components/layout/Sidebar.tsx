/**
 * Sidebar Component
 *
 * Navigation sidebar for the main app layout.
 * Shows navigation links, feed list with unread counts.
 */

"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { UnsubscribeDialog } from "@/components/feeds/UnsubscribeDialog";

interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const pathname = usePathname();
  const [unsubscribeTarget, setUnsubscribeTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const subscriptionsQuery = trpc.subscriptions.list.useQuery();
  const utils = trpc.useUtils();

  const unsubscribeMutation = trpc.subscriptions.delete.useMutation({
    onSuccess: () => {
      utils.subscriptions.list.invalidate();
      setUnsubscribeTarget(null);
    },
  });

  // Calculate total unread count
  const totalUnreadCount =
    subscriptionsQuery.data?.items.reduce((sum, item) => sum + item.subscription.unreadCount, 0) ??
    0;

  const isActiveLink = (href: string) => {
    if (href === "/all") {
      return pathname === "/all";
    }
    if (href === "/starred") {
      return pathname === "/starred";
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
            className={`flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors ${
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
            className={`flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isActiveLink("/starred")
                ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            Starred
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

                return (
                  <li key={subscription.id} className="group relative">
                    <Link
                      href={feedHref}
                      onClick={handleClose}
                      className={`flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
                        isActive
                          ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                          : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      }`}
                    >
                      <span className="truncate pr-2">{title}</span>
                      {subscription.unreadCount > 0 && (
                        <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                          ({subscription.unreadCount})
                        </span>
                      )}
                    </Link>

                    {/* Unsubscribe button - visible on hover */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setUnsubscribeTarget({
                          id: subscription.id,
                          title,
                        });
                      }}
                      className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-zinc-200 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
                      title="Unsubscribe"
                    >
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
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </li>
                );
              })}
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
    </>
  );
}
