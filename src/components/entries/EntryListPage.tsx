/**
 * EntryListPage Server Component
 *
 * Shared server component that handles entry list prefetching for all list views.
 * Prefetches both the entry list and the specific entry (if viewing one).
 */

import { createHydrationHelpersForRequest } from "@/lib/trpc/server";
import { entriesListInputFor } from "@/lib/queries/entries-list-input";

interface EntryListPageProps {
  /** The resolved pathname for this page (e.g., "/all", "/subscription/abc123"). */
  pathname: string;
  /** Search params from Next.js page */
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * Server component for entry list pages: prefetches the list for the
 * location, the open entry (?entry=) and the subscription. Renders nothing;
 * the layout's HydrateClient hydrates the prefetched data and AppRouter renders
 * the page.
 *
 * @example
 * ```tsx
 * // In page.tsx
 * export default function AllPage({ searchParams }) {
 *   return <EntryListPage pathname="/all" searchParams={searchParams} />;
 * }
 * ```
 */
export async function EntryListPage({ pathname, searchParams }: EntryListPageProps) {
  const params = await searchParams;
  // As the browser's URLSearchParams sees the query: a repeated param keeps
  // every value, and `get` reads the first.
  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of [value ?? []].flat()) urlParams.append(key, v);
  }

  // Uses the same QueryClient as the layout (via cache()) to share prefetched
  // data. The layout already verified authentication.
  const { trpc } = await createHydrationHelpersForRequest();

  const input = entriesListInputFor(pathname, urlParams);
  void trpc.entries.list.prefetchInfinite(input);
  const entryId = urlParams.get("entry");
  if (entryId != null) {
    void trpc.entries.get.prefetch({ id: entryId });
  }
  if (input.subscriptionId != null) {
    void trpc.subscriptions.get.prefetch({ id: input.subscriptionId });
  }

  return null;
}
