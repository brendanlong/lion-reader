/**
 * Reusable container for settings list pages.
 *
 * Handles the common loading/error/empty/list state cascade used across
 * settings pages. Two layout variants match the existing patterns:
 *
 * - "divide" (default): Single bordered container with `divide-y` between rows.
 *   Used by Email, BlockedSenders, BrokenFeeds.
 * - "card": `space-y-3` gap with individually bordered cards.
 *   Used by ApiTokens, Sessions.
 */

import type { ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { SettingsListSkeleton } from "@/components/settings/SettingsListSkeleton";

interface SettingsListContainerProps<T> {
  items: T[] | undefined;
  isLoading: boolean;
  error: unknown;
  renderItem: (item: T) => ReactNode;
  emptyState?: ReactNode;
  emptyMessage?: string;
  errorMessage?: string;
  variant?: "divide" | "card";
  skeletonCount?: number;
  skeletonHeight?: string;
  /** Extra content rendered inside the bordered container (divide variant only). */
  footer?: ReactNode;
}

export function SettingsListContainer<T>({
  items,
  isLoading,
  error,
  renderItem,
  emptyState,
  emptyMessage = "No items found.",
  errorMessage = "Failed to load data. Please try again.",
  variant = "divide",
  skeletonCount = 3,
  skeletonHeight,
  footer,
}: SettingsListContainerProps<T>) {
  const defaultEmpty = (
    <p className="ui-text-sm text-center text-zinc-500 dark:text-zinc-400">{emptyMessage}</p>
  );

  const resolvedEmptyState = emptyState ?? defaultEmpty;

  if (variant === "card") {
    return (
      <div className="space-y-3">
        {isLoading ? (
          <SettingsListSkeleton count={skeletonCount} variant="card" height={skeletonHeight} />
        ) : error ? (
          <Alert variant="error">{errorMessage}</Alert>
        ) : !items || items.length === 0 ? (
          resolvedEmptyState
        ) : (
          items.map(renderItem)
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      {isLoading ? (
        <SettingsListSkeleton count={skeletonCount} height={skeletonHeight} />
      ) : error ? (
        <div className="p-6">
          <Alert variant="error">{errorMessage}</Alert>
        </div>
      ) : !items || items.length === 0 ? (
        resolvedEmptyState
      ) : (
        <div className="divide-y divide-zinc-200 dark:divide-zinc-800">{items.map(renderItem)}</div>
      )}
      {footer}
    </div>
  );
}
