/**
 * TagList Component
 *
 * Renders the list of tags with unread counts in the sidebar.
 * Uses useSuspenseQuery so it can stream with Suspense boundaries.
 */

"use client";

import { Suspense, type ReactNode } from "react";
import { trpc } from "@/lib/trpc/client";
import { useExpandedTags } from "@/lib/hooks/useExpandedTags";
import { NavLinkWithIcon } from "@/components/ui/nav-link";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/ui/icons";
import { ColorDot } from "@/components/ui/color-picker";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { SIDEBAR_FEEDS_ATTRIBUTE } from "./sidebar-feed-navigation";
import {
  UNCATEGORIZED_SECTION,
  isInSidebarSection,
  isSidebarLinkCurrent,
  useSidebarSelection,
} from "@/lib/hooks/useSidebarSelection";
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
  onUnsubscribe: (sub: { id: string; title: string; isCollection: boolean }) => void;
  /** When true, only show tags/subscriptions with unread entries */
  unreadOnly: boolean;
  /** Called on mousedown with the link href (e.g., to prefetch data) */
  onPrefetch?: (href: string) => void;
}

interface TagSectionProps {
  href: string;
  isActive: boolean;
  color: string | null;
  label: string;
  count: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  onNavigate: (href: string) => void;
  onPrefetch?: (href: string) => void;
  /** The section's nested subscription list, shown when expanded */
  children: ReactNode;
}

/**
 * A collapsible sidebar section: chevron + link row, with its feeds nested below.
 */
function TagSection({
  href,
  isActive,
  color,
  label,
  count,
  expanded,
  onToggleExpanded,
  onNavigate,
  onPrefetch,
  children,
}: TagSectionProps) {
  return (
    <li>
      <div className="flex min-h-[44px] items-center">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpanded();
          }}
          className="text-muted hover:text-body flex h-6 w-6 shrink-0 items-center justify-center"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </button>
        <NavLinkWithIcon
          href={href}
          isActive={isActive}
          icon={<ColorDot color={color} size="sm" />}
          label={label}
          count={count}
          onClick={onNavigate}
          onPrefetch={onPrefetch}
        />
      </div>
      {expanded && children}
    </li>
  );
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
  const selection = useSidebarSelection();
  const { pathname, subscription: activeSubscription } = selection;
  const [tagsData] = trpc.tags.list.useSuspenseQuery();
  const { isExpanded, toggleExpanded } = useExpandedTags();

  const tags = tagsData.items;
  const uncategorized = tagsData.uncategorized;

  const activeTagId = pathname.startsWith("/tag/") ? pathname.slice("/tag/".length) : null;
  const isUncategorizedActive = pathname === "/uncategorized";
  const holdsActiveSubscription = (section: string) =>
    !!activeSubscription && isInSidebarSection(activeSubscription, section);

  // Visibility is driven by unread state, not feed counts (feedCount is only
  // surfaced in settings now). In unread-only mode a tag/section shows when it
  // has unread entries, is the current route, or holds the current
  // subscription, so what you're reading never drops out of the sidebar; in
  // show-read mode everything shows, including empty tags/sections.
  const sortedTags = [...(tags ?? [])]
    .filter(
      (tag) =>
        !unreadOnly ||
        tag.unreadCount > 0 ||
        tag.id === activeTagId ||
        holdsActiveSubscription(tag.id)
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const hasUncategorized =
    !unreadOnly ||
    (uncategorized?.unreadCount ?? 0) > 0 ||
    isUncategorizedActive ||
    holdsActiveSubscription(UNCATEGORIZED_SECTION);
  const hasTags = sortedTags.length > 0 || hasUncategorized;

  if (!hasTags) {
    return <p className="ui-text-sm text-muted px-3">No unread feeds</p>;
  }

  const listProps = {
    selection,
    onClose: onNavigate,
    onEdit,
    onUnsubscribe,
    unreadOnly,
    onPrefetch,
  };

  return (
    <ul className="space-y-1" {...{ [SIDEBAR_FEEDS_ATTRIBUTE]: "" }}>
      {sortedTags.map((tag) => (
        <TagSection
          key={tag.id}
          href={`/tag/${tag.id}`}
          isActive={isSidebarLinkCurrent(selection, `/tag/${tag.id}`)}
          color={tag.color}
          label={tag.name}
          count={tag.unreadCount}
          expanded={isExpanded(tag.id)}
          onToggleExpanded={() => toggleExpanded(tag.id)}
          onNavigate={onNavigate}
          onPrefetch={onPrefetch}
        >
          <TagSubscriptionList tagId={tag.id} {...listProps} />
        </TagSection>
      ))}

      {hasUncategorized && (
        <TagSection
          href="/uncategorized"
          isActive={isSidebarLinkCurrent(selection, "/uncategorized")}
          color={null}
          label="Uncategorized"
          count={uncategorized?.unreadCount ?? 0}
          expanded={isExpanded(UNCATEGORIZED_SECTION)}
          onToggleExpanded={() => toggleExpanded(UNCATEGORIZED_SECTION)}
          onNavigate={onNavigate}
          onPrefetch={onPrefetch}
        >
          <TagSubscriptionList uncategorized {...listProps} />
        </TagSection>
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
        <div key={i} className="bg-fill-muted h-9 animate-pulse rounded-md" />
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
