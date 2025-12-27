/**
 * EmptyState Component
 *
 * Reusable empty state component for displaying when there's no content.
 * Includes variants for different scenarios.
 */

"use client";

import { type ReactNode } from "react";
import Link from "next/link";
import { Button } from "./button";

/**
 * Icons for different empty state types.
 */
const Icons = {
  inbox: (
    <svg
      className="h-12 w-12"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"
      />
    </svg>
  ),
  star: (
    <svg
      className="h-12 w-12"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
      />
    </svg>
  ),
  rss: (
    <svg
      className="h-12 w-12"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6 5c7.18 0 13 5.82 13 13M6 11a7 7 0 017 7m-6 0a1 1 0 11-2 0 1 1 0 012 0z"
      />
    </svg>
  ),
  checkCircle: (
    <svg
      className="h-12 w-12"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  ),
};

interface EmptyStateProps {
  /**
   * Icon type to display.
   */
  icon?: keyof typeof Icons;

  /**
   * Custom icon element.
   */
  customIcon?: ReactNode;

  /**
   * Main title text.
   */
  title: string;

  /**
   * Description text.
   */
  description?: string;

  /**
   * Primary action button.
   */
  action?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };

  /**
   * Additional content to render below the action.
   */
  children?: ReactNode;
}

/**
 * EmptyState component.
 * A reusable empty state with icon, title, description, and optional action.
 */
export function EmptyState({
  icon = "inbox",
  customIcon,
  title,
  description,
  action,
  children,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="mb-4 text-zinc-400 dark:text-zinc-500" aria-hidden="true">
        {customIcon ?? Icons[icon]}
      </div>
      <h3 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">{title}</h3>
      {description && (
        <p className="mb-4 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
      )}
      {action && (
        <div className="mb-4">
          {action.href ? (
            <Link href={action.href}>
              <Button variant="primary">{action.label}</Button>
            </Link>
          ) : (
            <Button variant="primary" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * NoSubscriptions empty state.
 * Shown when user has no feed subscriptions.
 */
export function NoSubscriptionsEmptyState() {
  return (
    <EmptyState
      icon="rss"
      title="No subscriptions yet"
      description="Subscribe to your favorite blogs, news sites, and podcasts to see their latest content here."
      action={{
        label: "Add your first subscription",
        href: "/subscribe",
      }}
    />
  );
}

/**
 * NoEntries empty state.
 * Shown when a feed has no entries.
 */
export function NoEntriesEmptyState({ feedName }: { feedName?: string }) {
  return (
    <EmptyState
      icon="inbox"
      title="No entries yet"
      description={
        feedName
          ? `"${feedName}" hasn't published any new content since you subscribed.`
          : "This feed hasn't published any new content since you subscribed."
      }
    />
  );
}

/**
 * NoStarredEntries empty state.
 * Shown when user has no starred entries.
 */
export function NoStarredEntriesEmptyState() {
  return (
    <EmptyState
      icon="star"
      title="No starred entries"
      description="Star entries to save them for later. They'll appear here so you can easily find them."
      action={{
        label: "Browse all entries",
        href: "/all",
      }}
    />
  );
}

/**
 * AllReadEmptyState empty state.
 * Shown when user has read all entries.
 */
export function AllReadEmptyState() {
  return (
    <EmptyState
      icon="checkCircle"
      title="All caught up!"
      description="You've read all your entries. Check back later for new content."
    />
  );
}

/**
 * NoUnreadEntries empty state.
 * Shown when filtering for unread entries but there are none.
 */
export function NoUnreadEntriesEmptyState() {
  return (
    <EmptyState
      icon="checkCircle"
      title="No unread entries"
      description="You've read everything! Check back later for new content from your subscriptions."
    />
  );
}
