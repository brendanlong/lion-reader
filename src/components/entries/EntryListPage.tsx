/**
 * EntryListPage Server Component
 *
 * Shared server component that handles entry list prefetching for all list views.
 * Skips prefetch when an entry is open (?entry= param) to avoid refetching the list
 * when just viewing an entry.
 */

import { createHydrationHelpersForRequest, isAuthenticated } from "@/lib/trpc/server";
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
 * - Skipping prefetch when viewing an entry (prevents list refetch)
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

  // Skip prefetch if viewing an entry - the list is already cached on the client
  // This prevents the list from refetching when clicking into an entry
  const isViewingEntry = !!params.entry;

  if ((await isAuthenticated()) && !isViewingEntry) {
    // Get tRPC caller for prefetching
    // Uses the same QueryClient as the layout (via cache()) to share prefetched data
    const { trpc } = await createHydrationHelpersForRequest();

    // Parse view preferences from URL (same logic as client hook)
    const urlParams = new URLSearchParams();
    if (params.unreadOnly) urlParams.set("unreadOnly", String(params.unreadOnly));
    if (params.sort) urlParams.set("sort", String(params.sort));
    const { unreadOnly, sortOrder } = parseViewPreferencesFromParams(urlParams);

    // Build input using shared function to ensure cache key matches client
    const input = buildEntriesListInput(filters, { unreadOnly, sortOrder });

    // Prefetch entries - data goes into the shared QueryClient
    // The layout's HydrateClient will dehydrate all prefetched data
    await trpc.entries.list.prefetchInfinite(input);
  }

  // Return children directly - the layout's HydrateClient handles hydration
  return <>{children}</>;
}
