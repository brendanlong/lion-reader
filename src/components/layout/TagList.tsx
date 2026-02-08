/**
 * TagList Component
 *
 * Renders the list of tags with unread counts in the sidebar.
 * Uses TanStack DB live queries for reactive updates from the tags collection.
 * Uncategorized counts come from the counts collection (populated by the tags fetch).
 */

"use client";

import { Suspense, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useLiveSuspenseQuery, useLiveQuery } from "@tanstack/react-db";
import { ClientLink } from "@/components/ui/client-link";
import { useCollections } from "@/lib/collections/context";
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
}

/**
 * Inner component that suspends on tags collection.
 */
function TagListContent({ onNavigate, onEdit, onUnsubscribe }: TagListProps) {
  const pathname = usePathname();
  const { tags: tagsCollection, counts: countsCollection } = useCollections();
  const { data: tags } = useLiveSuspenseQuery(tagsCollection);
  const { data: allCounts } = useLiveQuery(countsCollection);
  const { isExpanded, toggleExpanded } = useExpandedTags();

  // Get uncategorized counts from the counts collection
  const uncategorized = useMemo(() => {
    const record = allCounts.find((c) => c.id === "uncategorized");
    return {
      feedCount: record?.total ?? 0,
      unreadCount: record?.unread ?? 0,
    };
  }, [allCounts]);

  // Tags sorted alphabetically, showing only tags that have subscriptions
  const sortedTags = useMemo(
    () => [...tags].filter((tag) => tag.feedCount > 0).sort((a, b) => a.name.localeCompare(b.name)),
    [tags]
  );

  const hasUncategorized = uncategorized.feedCount > 0;
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

  if (!hasTags) {
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
              count={uncategorized.unreadCount}
              onClick={onNavigate}
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
