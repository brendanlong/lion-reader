/**
 * Tag Entries Page
 *
 * Displays entries from a specific tag or uncategorized feeds.
 * Prefetches entries on the server for faster initial load.
 */

import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { createServerCaller, createServerQueryClient, isAuthenticated } from "@/lib/trpc/server";
import { parseViewPreferencesFromParams } from "@/lib/hooks/viewPreferences";
import { TagEntriesContent } from "./TagEntriesContent";

interface TagEntriesPageProps {
  params: Promise<{ tagId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function TagEntriesPage({ params, searchParams }: TagEntriesPageProps) {
  const queryClient = createServerQueryClient();

  if (await isAuthenticated()) {
    const trpc = await createServerCaller();
    const { tagId } = await params;
    const searchParamsResolved = await searchParams;

    // Parse view preferences from URL (same logic as client hook)
    const urlParams = new URLSearchParams();
    if (searchParamsResolved.unreadOnly)
      urlParams.set("unreadOnly", String(searchParamsResolved.unreadOnly));
    if (searchParamsResolved.sort) urlParams.set("sort", String(searchParamsResolved.sort));
    const { unreadOnly, sortOrder } = parseViewPreferencesFromParams(urlParams);

    // Check if this is the "uncategorized" pseudo-tag
    const isUncategorized = tagId === "uncategorized";

    // Prefetch entries with the appropriate filter
    // IMPORTANT: Include ALL fields (even undefined) to match the query key structure
    // that tRPC generates on the client side
    const input = isUncategorized
      ? {
          subscriptionId: undefined,
          tagId: undefined,
          uncategorized: true as const,
          unreadOnly,
          starredOnly: undefined,
          sortOrder,
          type: undefined,
          limit: 10,
        }
      : {
          subscriptionId: undefined,
          tagId,
          uncategorized: undefined,
          unreadOnly,
          starredOnly: undefined,
          sortOrder,
          type: undefined,
          limit: 10,
        };

    await queryClient.prefetchInfiniteQuery({
      queryKey: [["entries", "list"], { input, type: "infinite" }],
      queryFn: () => trpc.entries.list(input),
      initialPageParam: undefined as string | undefined,
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TagEntriesContent />
    </HydrationBoundary>
  );
}
