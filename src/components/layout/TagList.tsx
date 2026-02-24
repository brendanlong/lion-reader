/**
 * TagList Component
 *
 * Renders the list of tags with unread counts in the sidebar.
 * Uses useSuspenseQuery so it can stream with Suspense boundaries.
 */

"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { ClientLink } from "@/components/ui/client-link";
import { trpc } from "@/lib/trpc/client";
import { useExpandedTags } from "@/lib/hooks/useExpandedTags";
import { NavLinkWithIcon } from "@/components/ui/nav-link";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/ui/icon-button";
import { ColorDot } from "@/components/ui/color-picker";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { TagSubscriptionList } from "./TagSubscriptionList";

interface TagListProps {
  onNavigate: () => void;
  onEdit: (sub: {
    id: string;
    title: string;
    customTitle: string | null;
    tagIds: string[];
  }) => void;
  onUnsubscribe: (sub: { id: string; title: string }) => void;
  /** When true, only show tags/subscriptions with unread entries */
  unreadOnly: boolean;
  /** Called on mousedown with the link href (e.g., to prefetch data) */
  onPrefetch?: (href: string) => void;
}

/**
 * Inner component that suspends on tags.list query.
 */
function TagListContent({
  onNavigate,
  onEdit,
  onUnsubscribe,
  unreadOnly,
  onPrefetch,
}: TagListProps) {
  const pathname = usePathname();
  const [tagsData] = trpc.tags.list.useSuspenseQuery();
  const { isExpanded, toggleExpanded } = useExpandedTags();

  const tags = tagsData.items;
  const uncategorized = tagsData.uncategorized;

  // Determine which tag/uncategorized is currently active so we always show it
  const activeTagId = pathname.startsWith("/tag/") ? pathname.slice("/tag/".length) : null;
  const isUncategorizedActive = pathname === "/uncategorized";

  // Tags sorted alphabetically, showing only tags that have subscriptions.
  // When unreadOnly, also hide tags with 0 unread (unless currently active).
  const sortedTags = [...(tags ?? [])]
    .filter((tag) => {
      if (tag.feedCount === 0) return false;
      if (unreadOnly && tag.unreadCount === 0 && tag.id !== activeTagId) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const hasUncategorized =
    (uncategorized?.feedCount ?? 0) > 0 &&
    (!unreadOnly || (uncategorized?.unreadCount ?? 0) > 0 || isUncategorizedActive);
  const hasTags = sortedTags.length > 0 || hasUncategorized;

  const isActiveLink = (href: string) => {
    if (href === "/uncategorized") {
      return pathname === "/uncategorized";
    }
    if (href.startsWith("/tag/")) {
      return pathname === href;
    }
    return pathname.startsWith(href);
  };

  // Check if user has any subscriptions at all (ignoring unread filter)
  const hasAnySubscriptions =
    (tags ?? []).some((tag) => tag.feedCount > 0) || (uncategorized?.feedCount ?? 0) > 0;

  if (!hasAnySubscriptions) {
    return (
      <p className="ui-text-sm px-3 text-zinc-500 dark:text-zinc-400">
        No subscriptions yet.{" "}
        <ClientLink
          href="/subscribe"
          onNavigate={onNavigate}
          className="text-zinc-900 underline dark:text-zinc-50"
        >
          Add one
        </ClientLink>
      </p>
    );
  }

  if (!hasTags) {
    return <p className="ui-text-sm px-3 text-zinc-500 dark:text-zinc-400">No unread feeds</p>;
  }

  return (
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
                onClick={onNavigate}
                onPrefetch={onPrefetch}
              />
            </div>

            {/* Nested feeds (when expanded) - loaded per-tag */}
            {expanded && (
              <TagSubscriptionList
                tagId={tag.id}
                pathname={pathname}
                onClose={onNavigate}
                onEdit={onEdit}
                onUnsubscribe={onUnsubscribe}
                unreadOnly={unreadOnly}
                onPrefetch={onPrefetch}
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
              onClick={onNavigate}
              onPrefetch={onPrefetch}
            />
          </div>

          {/* Nested uncategorized feeds (when expanded) */}
          {isExpanded("uncategorized") && (
            <TagSubscriptionList
              uncategorized
              pathname={pathname}
              onClose={onNavigate}
              onEdit={onEdit}
              onUnsubscribe={onUnsubscribe}
              unreadOnly={unreadOnly}
              onPrefetch={onPrefetch}
            />
          )}
        </li>
      )}
    </ul>
  );
}

/**
 * Skeleton fallback for TagList while suspending.
 */
function TagListSkeleton() {
  return (
    <div className="space-y-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-9 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800" />
      ))}
    </div>
  );
}

/**
 * Error fallback for TagList.
 */
function TagListError() {
  return <p className="ui-text-sm px-3 text-red-600 dark:text-red-400">Failed to load feeds</p>;
}

/**
 * TagList with built-in Suspense and ErrorBoundary.
 */
export function TagList(props: TagListProps) {
  return (
    <ErrorBoundary fallback={<TagListError />}>
      <Suspense fallback={<TagListSkeleton />}>
        <TagListContent {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
