/**
 * Tag Entries Page
 *
 * Server component that prefetches data for the tag entries view.
 * The actual UI is rendered by the client component.
 */

import { dehydrate } from "@tanstack/react-query";
import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
import { HydrationBoundary } from "@/lib/trpc/provider";
import { getViewPreferences } from "@/lib/hooks/viewPreferences";
import { TagEntriesClient } from "./client";

interface PageProps {
  params: Promise<{ tagId: string }>;
  searchParams: Promise<{ unreadOnly?: string; sort?: string }>;
}

export default async function TagEntriesPage({ params, searchParams }: PageProps) {
  const { tagId } = await params;
  const queryClient = createServerQueryClient();
  const { caller, session } = await createServerCaller();

  const isUncategorized = tagId === "uncategorized";

  // Parse URL params for view preferences
  const queryParams = await searchParams;
  const viewType = isUncategorized ? "uncategorized" : "tag";
  const defaults = getViewPreferences(viewType, isUncategorized ? undefined : tagId);
  const unreadOnly =
    queryParams.unreadOnly === "false"
      ? false
      : queryParams.unreadOnly === "true"
        ? true
        : defaults.showUnreadOnly;
  const sortOrder =
    queryParams.sort === "oldest"
      ? "oldest"
      : queryParams.sort === "newest"
        ? "newest"
        : defaults.sortOrder;

  if (session) {
    // Prefetch entries list with tag filter (infinite query)
    const entriesInput = isUncategorized
      ? { uncategorized: true as const, unreadOnly, sortOrder, limit: 20 }
      : { tagId, unreadOnly, sortOrder, limit: 20 };

    await queryClient.prefetchInfiniteQuery({
      queryKey: [["entries", "list"], { input: entriesInput, type: "infinite" }],
      queryFn: () => caller.entries.list(entriesInput),
      initialPageParam: undefined,
    });

    // Prefetch tags for tag info
    await queryClient.prefetchQuery({
      queryKey: [["tags", "list"], { input: undefined, type: "query" }],
      queryFn: () => caller.tags.list(),
    });

    // Prefetch subscriptions for unread counts (used by both tag and uncategorized views)
    await queryClient.prefetchQuery({
      queryKey: [["subscriptions", "list"], { input: undefined, type: "query" }],
      queryFn: () => caller.subscriptions.list(),
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TagEntriesClient />
    </HydrationBoundary>
  );
}
