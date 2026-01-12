/**
 * Saved Articles Page
 *
 * Server component that prefetches data for the saved articles view.
 * Reads view preferences from URL query params for accurate prefetching.
 */

import { dehydrate } from "@tanstack/react-query";
import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
import { HydrationBoundary } from "@/lib/trpc/provider";
import { SavedArticlesClient } from "./client";
import { getViewPreferences } from "@/lib/hooks/viewPreferences";

interface PageProps {
  searchParams: Promise<{
    unreadOnly?: string;
    sort?: string;
    entry?: string;
  }>;
}

export default async function SavedArticlesPage({ searchParams }: PageProps) {
  const params = await searchParams;

  // Get defaults from localStorage pattern (server will use defaults)
  const defaults = getViewPreferences("saved");

  // Parse URL params with fallback to defaults
  const unreadOnly =
    params.unreadOnly === "false"
      ? false
      : params.unreadOnly === "true"
        ? true
        : defaults.showUnreadOnly;
  const sortOrder =
    params.sort === "oldest" ? "oldest" : params.sort === "newest" ? "newest" : defaults.sortOrder;

  const queryClient = createServerQueryClient();
  const { caller, session } = await createServerCaller();

  if (session) {
    // Prefetch saved articles list with URL-specified filters
    await queryClient.prefetchInfiniteQuery({
      queryKey: [
        ["entries", "list"],
        {
          input: { type: "saved", unreadOnly, sortOrder, limit: 20 },
          type: "infinite",
        },
      ],
      queryFn: () => caller.entries.list({ type: "saved", unreadOnly, sortOrder, limit: 20 }),
      initialPageParam: undefined,
    });

    // Prefetch entry content if viewing a specific entry
    // This eliminates the second round-trip when opening an entry
    if (params.entry) {
      await queryClient.prefetchQuery({
        queryKey: [["entries", "get"], { input: { id: params.entry }, type: "query" }],
        queryFn: () => caller.entries.get({ id: params.entry! }),
      });
    }
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <SavedArticlesClient />
    </HydrationBoundary>
  );
}
