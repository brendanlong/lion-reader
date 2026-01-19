/**
 * Tag Page Loading State
 *
 * Shows immediately during client-side navigation while the server
 * component runs. This prevents the page from "hanging" while waiting
 * for the server prefetch to complete.
 */

import { EntryListSkeleton } from "@/components/entries/EntryListSkeleton";

export default function TagLoading() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      {/* Breadcrumb skeleton */}
      <div className="mb-2">
        <div className="h-9 w-24 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-700" />
      </div>

      {/* Header skeleton with color dot */}
      <div className="mb-4 sm:mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-4 w-4 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-700" />
            <div className="h-8 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
            <div className="h-6 w-16 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-700" />
          </div>
          <div className="flex gap-2">
            <div className="h-9 w-9 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-700" />
            <div className="h-9 w-9 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-700" />
          </div>
        </div>
      </div>

      <EntryListSkeleton count={10} />
    </div>
  );
}
