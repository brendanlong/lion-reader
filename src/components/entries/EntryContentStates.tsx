/**
 * Entry Content States
 *
 * Loading skeleton and error state components for entry content.
 */

import { Button, AlertIcon } from "@/components/ui";

/**
 * Loading skeleton for entry content.
 */
export function EntryContentSkeleton() {
  return (
    <div className="mx-auto max-w-3xl animate-pulse px-4 py-6 sm:py-8">
      {/* Back button placeholder */}
      <div className="mb-6 h-8 w-20 rounded bg-zinc-200 dark:bg-zinc-700" />

      {/* Title placeholder */}
      <div className="mb-2 h-8 w-3/4 rounded bg-zinc-200 dark:bg-zinc-700" />
      <div className="mb-4 h-8 w-1/2 rounded bg-zinc-200 dark:bg-zinc-700" />

      {/* Meta row placeholder */}
      <div className="mb-6 flex items-center gap-4">
        <div className="h-4 w-24 rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>

      {/* Action buttons placeholder */}
      <div className="mb-8 flex gap-3">
        <div className="h-10 w-24 rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-10 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>

      {/* Content placeholders */}
      <div className="space-y-4">
        <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-4 w-5/6 rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-4 w-full rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="h-4 w-3/4 rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
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
