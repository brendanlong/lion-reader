/**
 * EntryListPage Server Component
 *
 * Shared server component that handles entry list prefetching for all list views.
 * Skips prefetch when an entry is open (?entry= param) to avoid refetching the list
 * when just viewing an entry.
 */

import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { createServerCaller, createServerQueryClient, isAuthenticated } from "@/lib/trpc/server";
import { parseViewPreferencesFromParams } from "@/lib/hooks/viewPreferences";

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
  const queryClient = createServerQueryClient();
  const params = await searchParams;

  // Skip prefetch if viewing an entry - the list is already cached on the client
  // This prevents the list from refetching when clicking into an entry
  const isViewingEntry = !!params.entry;

  if ((await isAuthenticated()) && !isViewingEntry) {
    const trpc = await createServerCaller();

    // Parse view preferences from URL (same logic as client hook)
    const urlParams = new URLSearchParams();
    if (params.unreadOnly) urlParams.set("unreadOnly", String(params.unreadOnly));
    if (params.sort) urlParams.set("sort", String(params.sort));
    const { unreadOnly, sortOrder } = parseViewPreferencesFromParams(urlParams);

    // Build input matching the query key structure tRPC generates on the client
    // IMPORTANT: Include ALL fields (even undefined) to match exactly
    const input = {
      subscriptionId: filters.subscriptionId,
      tagId: filters.tagId,
      uncategorized: filters.uncategorized,
      unreadOnly,
      starredOnly: filters.starredOnly,
      sortOrder,
      type: filters.type,
      limit: 10,
    };

    await queryClient.prefetchInfiniteQuery({
      queryKey: [["entries", "list"], { input, type: "infinite" }],
      queryFn: () => trpc.entries.list(input),
      initialPageParam: undefined as string | undefined,
    });
  }

  return <HydrationBoundary state={dehydrate(queryClient)}>{children}</HydrationBoundary>;
}
