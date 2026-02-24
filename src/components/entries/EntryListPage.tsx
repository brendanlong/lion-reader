/**
 * EntryListPage Server Component
 *
 * Shared server component that handles entry list prefetching for all list views.
 * Prefetches both the entry list and the specific entry (if viewing one).
 */

import { createHydrationHelpersForRequest } from "@/lib/trpc/server";
import { parseViewPreferencesFromParams } from "@/lib/hooks/viewPreferences";
import {
  buildEntriesListInput,
  getDefaultViewPreferences,
  getFiltersFromPathname,
  type EntriesListFilters,
  type EntriesListInput,
} from "@/lib/queries/entries-list-input";

// Re-export for consumers
export type { EntriesListFilters, EntriesListInput };

interface EntryListPageProps {
  /**
   * The resolved pathname for this page (e.g., "/all", "/subscription/abc123").
   * Used to derive filters and default view preferences via the centralized
   * getFiltersFromPathname and getDefaultViewPreferences functions, ensuring
   * server prefetch cache keys match client queries exactly.
   */
  pathname: string;
  /** Search params from Next.js page */
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
  /** Optional client component to render alongside prefetched data */
  children?: React.ReactNode;
}

/**
 * Server component wrapper for entry list pages.
 *
 * Handles:
 * - Prefetching entry list with filters derived from pathname
 * - Prefetching specific entry when viewing one (?entry= param)
 * - Passing hydrated state to client
 *
 * Uses the same getFiltersFromPathname and getDefaultViewPreferences functions
 * as the client hooks, ensuring server prefetch cache keys match exactly.
 *
 * @example
 * ```tsx
 * // In page.tsx
 * export default function AllPage({ searchParams }) {
 *   return <EntryListPage pathname="/all" searchParams={searchParams} />;
 * }
 * ```
 */
export async function EntryListPage({ pathname, searchParams, children }: EntryListPageProps) {
  const params = await searchParams;

  // Check if viewing a specific entry
  const entryId = typeof params.entry === "string" ? params.entry : undefined;

  // Get tRPC caller for prefetching
  // Uses the same QueryClient as the layout (via cache()) to share prefetched data
  // Note: Layout already verified authentication, so we skip that check here
  const { trpc } = await createHydrationHelpersForRequest();

  // Derive filters and defaults from pathname (same functions as client hooks)
  const filters = getFiltersFromPathname(pathname);
  const defaults = getDefaultViewPreferences(pathname);

  // Parse view preferences from URL, using route-specific defaults
  const urlParams = new URLSearchParams();
  if (params.unreadOnly) urlParams.set("unreadOnly", String(params.unreadOnly));
  if (params.sort) urlParams.set("sort", String(params.sort));
  const { unreadOnly, sortOrder } = parseViewPreferencesFromParams(urlParams, {
    unreadOnly: defaults.unreadOnly,
  });

  // Build input using shared function to ensure cache key matches client
  const input = buildEntriesListInput(filters, { unreadOnly, sortOrder });

  // Prefetch the entry list and related data
  void trpc.entries.list.prefetchInfinite(input);
  if (entryId != null) {
    void trpc.entries.get.prefetch({ id: entryId });
  }
  if (filters.subscriptionId != null) {
    void trpc.subscriptions.get.prefetch({ id: filters.subscriptionId });
  }

  // Return children directly - the layout's HydrateClient handles hydration
  return <>{children}</>;
}
