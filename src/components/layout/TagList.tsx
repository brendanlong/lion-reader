/**
 * TagList Component
 *
 * Renders the list of tags with unread counts in the sidebar.
 * Uses useSuspenseQuery so it can stream with Suspense boundaries.
 */

"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { useExpandedTags } from "@/lib/hooks/useExpandedTags";
import { NavLinkWithIcon } from "@/components/ui/nav-link";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/ui/icon-button";
import { ColorDot } from "@/components/ui/color-picker";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { TagSubscriptionList } from "./TagSubscriptionList";

interface TagListProps {
  /** Called with the link href when a tag/subscription link is clicked */
  onNavigate: (href: string) => void;
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

  // Visibility is driven by unread state, not feed counts (feedCount is only
  // surfaced in settings now). In unread-only mode a tag/section shows when it
  // has unread entries (or is the active route); in show-read mode everything
  // shows, including empty tags/sections.
  const sortedTags = [...(tags ?? [])]
    .filter((tag) => {
      if (unreadOnly && tag.unreadCount === 0 && tag.id !== activeTagId) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const hasUncategorized =
    !unreadOnly || (uncategorized?.unreadCount ?? 0) > 0 || isUncategorizedActive;
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
    return <p className="ui-text-sm text-muted px-3">No unread feeds</p>;
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
                className="text-muted hover:text-body flex h-6 w-6 shrink-0 items-center justify-center"
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
              className="text-muted hover:text-body flex h-6 w-6 shrink-0 items-center justify-center"
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
        <div key={i} className="bg-surface-muted h-9 animate-pulse rounded-md" />
      ))}
    </div>
  );
}

/**
 * Error fallback for TagList.
 */
function TagListError() {
  return <p className="ui-text-sm text-danger px-3">Failed to load feeds</p>;
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
