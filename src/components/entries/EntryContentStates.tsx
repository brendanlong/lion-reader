/**
 * Entry Content States
 *
 * Loading skeleton and error state components for entry content.
 */

import { Button, AlertIcon } from "@/components/ui";

/**
 * Loading skeleton for entry content.
 * Used when there's no cached data available.
 */
export function EntryContentSkeleton() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
      {/* Back button placeholder */}
      <div className="mb-4 h-10 w-28 animate-pulse rounded bg-zinc-200 sm:mb-6 dark:bg-zinc-700" />

      {/* Header section */}
      <header className="mb-6 sm:mb-8">
        {/* Title row with vote controls placeholder */}
        <div className="mb-4 flex gap-4 sm:mb-6">
          <div className="min-w-0 flex-1">
            {/* Title placeholder */}
            <div className="mb-2 h-8 w-3/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
            <div className="mb-4 h-8 w-1/2 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />

            {/* Meta row placeholder */}
            <div className="flex items-center gap-4">
              <div className="h-4 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="h-4 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
            </div>
          </div>

          {/* Vote controls placeholder */}
          <div className="shrink-0">
            <div className="flex h-24 w-10 animate-pulse flex-col items-center justify-center rounded bg-zinc-200 dark:bg-zinc-700" />
          </div>
        </div>

        {/* Action buttons placeholder */}
        <div className="flex gap-2 sm:gap-3">
          <div className="h-10 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
          <div className="h-10 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
          <div className="h-10 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
          <div className="h-10 w-20 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
        </div>
      </header>

      {/* Divider - always show (not animated) */}
      <hr className="mb-6 border-zinc-200 sm:mb-8 dark:border-zinc-700" />

      {/* Content placeholders */}
      <ContentSkeleton />
    </div>
  );
}

/**
 * Error state component for entry content.
 */
export function EntryContentError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <AlertIcon className="mb-4 h-16 w-16 text-red-400 dark:text-red-500" />
      <p className="ui-text-base mb-4 text-zinc-600 dark:text-zinc-400">{message}</p>
      <Button onClick={onRetry} variant="secondary">
        Try again
      </Button>
    </div>
  );
}

/**
 * Skeleton for the content area only (used during progressive loading).
 * Shows a loading skeleton in the content area while header is already visible.
 */
export function ContentSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
      <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
      <div className="h-4 w-5/6 rounded bg-zinc-200 dark:bg-zinc-700" />
      <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
      <div className="h-4 w-3/4 rounded bg-zinc-200 dark:bg-zinc-700" />
      <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
      <div className="h-4 w-4/5 rounded bg-zinc-200 dark:bg-zinc-700" />
    </div>
  );
}
