/**
 * EntryListPage Server Component
 *
 * Shared server component that handles entry list prefetching for all list views.
 * Prefetches both the entry list and the specific entry (if viewing one).
 */

import { createHydrationHelpersForRequest } from "@/lib/trpc/server";
import { parseViewPreferencesFromParams } from "@/lib/hooks/viewPreferences";
import { buildEntriesListInput, type EntriesListInput } from "@/lib/queries/entries-list-input";

/**
 * Filters for the entry list query.
 */
export interface EntryListFilters {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  starredOnly?: boolean;
  type?: "web" | "email" | "saved";
}

// Re-export for consumers
export type { EntriesListInput };

interface EntryListPageProps {
  /** Filters for the entry list query */
  filters: EntryListFilters;
  /** Search params from Next.js page */
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
  /** The client component to render */
  children: React.ReactNode;
}

/**
 * Server component wrapper for entry list pages.
 *
 * Handles:
 * - Prefetching entry list with filters
 * - Prefetching specific entry when viewing one (?entry= param)
 * - Passing hydrated state to client
 *
 * Uses tRPC's hydration helpers to ensure query keys match exactly between
 * server prefetch and client query, preventing hydration mismatches.
 *
 * @example
 * ```tsx
 * // In page.tsx
 * export default function AllPage({ searchParams }) {
 *   return (
 *     <EntryListPage filters={{}} searchParams={searchParams}>
 *       <AllEntriesContent />
 *     </EntryListPage>
 *   );
 * }
 * ```
 */
export async function EntryListPage({ filters, searchParams, children }: EntryListPageProps) {
  const params = await searchParams;

  // Check if viewing a specific entry
  const entryId = typeof params.entry === "string" ? params.entry : undefined;

  // Get tRPC caller for prefetching
  // Uses the same QueryClient as the layout (via cache()) to share prefetched data
  // Note: Layout already verified authentication, so we skip that check here
  const { trpc } = await createHydrationHelpersForRequest();

  // Parse view preferences from URL (same logic as client hook)
  const urlParams = new URLSearchParams();
  if (params.unreadOnly) urlParams.set("unreadOnly", String(params.unreadOnly));
  if (params.sort) urlParams.set("sort", String(params.sort));
  const { unreadOnly, sortOrder } = parseViewPreferencesFromParams(urlParams);

  // Build input using shared function to ensure cache key matches client
  const input = buildEntriesListInput(filters, { unreadOnly, sortOrder });

  // Prefetch the entry list (always needed for sidebar)
  // Also prefetch the specific entry if viewing one
  await Promise.all([
    trpc.entries.list.prefetchInfinite(input),
    entryId ? trpc.entries.get.prefetch({ id: entryId }) : Promise.resolve(),
  ]);

  // Return children directly - the layout's HydrateClient handles hydration
  return <>{children}</>;
}
