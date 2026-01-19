/**
 * All Entries Loading State
 *
 * Shows immediately during client-side navigation while the server
 * component runs. This prevents the page from "hanging" while waiting
 * for the server prefetch to complete.
 */

import { EntryListSkeleton } from "@/components/entries/EntryListSkeleton";

export default function AllEntriesLoading() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between sm:mb-6">
        <div className="h-8 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
        <div className="flex gap-2">
          <div className="h-9 w-9 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-700" />
          <div className="h-9 w-9 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-700" />
        </div>
      </div>
      <EntryListSkeleton count={10} />
    </div>
  );
}
