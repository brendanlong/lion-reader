/**
 * UnifiedEntriesContent Component
 *
 * A single client component that handles all entry list pages by reading
 * the current URL to determine what to render. This enables client-side
 * navigation via pushState without triggering SSR.
 *
 * When the URL changes via pushState, usePathname() updates, which causes
 * this component to re-derive filters and render the appropriate content.
 *
 * Server components still handle prefetching via EntryListPage - this just
 * unifies the client-side rendering.
 */

"use client";

import { useMemo, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { EntryPageLayout, TitleSkeleton, TitleText } from "./EntryPageLayout";
import { EntryContent } from "./EntryContent";
import { EntryListContainer } from "./EntryListContainer";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { NotFoundCard } from "@/components/ui/not-found-card";
import { useEntryUrlState } from "@/lib/hooks/useEntryUrlState";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
import { useEntriesListInput } from "@/lib/hooks/useEntriesListInput";
import { useIsHydrated } from "@/lib/hooks/useIsHydrated";
import { extractParamsFromPathname } from "@/lib/navigation";
import { type ViewType } from "@/lib/hooks/viewPreferences";
import { trpc } from "@/lib/trpc/client";
import { findCachedSubscription } from "@/lib/cache/count-cache";
import { reconcileListReadStarredFromEntryGet } from "@/lib/cache/entry-cache";
import { type EntryType } from "@/lib/hooks/useEntryMutations";

/**
 * Route info derived from the current pathname.
 */
interface RouteInfo {
  viewId: ViewType;
  filters: {
    subscriptionId?: string;
    tagId?: string;
    uncategorized?: boolean;
    starredOnly?: boolean;
    type?: EntryType;
    sortBy?: "published" | "readChanged";
  };
  /** Static title (null means we need to fetch it) */
  title: string | null;
  /** Whether this route needs to fetch a subscription for its title */
  subscriptionId?: string;
  /** Whether this route needs to fetch a tag for its title */
  tagId?: string;
  /** Empty message when showing unread only */
  emptyMessageUnread: string;
  /** Empty message when showing all entries */
  emptyMessageAll: string;
  /** Description for mark all read dialog */
  markAllReadDescription: string;
  /** Whether to hide the sort toggle (e.g., for algorithmic feed) */
  hideSortToggle?: boolean;
}

/**
 * Parse the current pathname to derive route info.
 */
function useRouteInfo(): RouteInfo {
  const pathname = usePathname();

  return useMemo(() => {
    const params = extractParamsFromPathname(pathname);

    // /all - All entries
    if (pathname === "/all") {
      return {
        viewId: "all" as const,
        filters: {},
        title: "All Items",
        emptyMessageUnread: "No unread entries. Toggle to show all items.",
        emptyMessageAll: "No entries yet. Subscribe to some feeds to see entries here.",
        markAllReadDescription: "all feeds",
      };
    }

    // /starred - Starred entries
    if (pathname === "/starred") {
      return {
        viewId: "starred" as const,
        filters: { starredOnly: true },
        title: "Starred",
        emptyMessageUnread: "No unread starred entries. Toggle to show all starred items.",
        emptyMessageAll: "No starred entries yet. Star entries to save them for later.",
        markAllReadDescription: "starred entries",
      };
    }

    // /saved - Saved articles
    if (pathname === "/saved") {
      return {
        viewId: "saved" as const,
        filters: { type: "saved" as const },
        title: "Saved",
        emptyMessageUnread: "No unread saved articles. Toggle to show all items.",
        emptyMessageAll: "No saved articles yet. Save articles to read them later.",
        markAllReadDescription: "saved articles",
      };
    }

    // /subscription/:id - Single subscription entries
    if (params.subscriptionId) {
      const subscriptionId = params.subscriptionId;
      return {
        viewId: "subscription" as const,
        filters: { subscriptionId },
        title: null, // Fetched from API
        subscriptionId,
        emptyMessageUnread: "No unread entries in this subscription. Toggle to show all items.",
        emptyMessageAll:
          "No entries in this subscription yet. Entries will appear here once the feed is fetched.",
        markAllReadDescription: "this subscription",
      };
    }

    // /uncategorized - Uncategorized entries
    if (pathname === "/uncategorized") {
      return {
        viewId: "uncategorized" as const,
        filters: { uncategorized: true },
        title: "Uncategorized",
        emptyMessageUnread: "No unread entries from uncategorized feeds. Toggle to show all items.",
        emptyMessageAll: "No entries from uncategorized feeds yet.",
        markAllReadDescription: "uncategorized feeds",
      };
    }

    // /tag/:tagId - Tag entries (including uncategorized pseudo-tag)
    if (params.tagId) {
      const tagId = params.tagId;

      // Handle "uncategorized" pseudo-tag
      if (tagId === "uncategorized") {
        return {
          viewId: "uncategorized" as const,
          filters: { uncategorized: true },
          title: "Uncategorized",
          emptyMessageUnread:
            "No unread entries from uncategorized feeds. Toggle to show all items.",
          emptyMessageAll: "No entries from uncategorized feeds yet.",
          markAllReadDescription: "uncategorized feeds",
        };
      }

      return {
        viewId: "tag" as const,
        filters: { tagId },
        title: null, // Fetched from API
        tagId,
        emptyMessageUnread: "No unread entries from this tag. Toggle to show all items.",
        emptyMessageAll: "No entries from this tag yet.",
        markAllReadDescription: "this tag",
      };
    }

    // /recently-read - Recently read entries
    if (pathname === "/recently-read") {
      return {
        viewId: "recently-read" as const,
        filters: { sortBy: "readChanged" as const },
        title: "Recently Read",
        emptyMessageUnread: "No unread entries. Toggle to show all items.",
        emptyMessageAll:
          "No recently read entries yet. Read some entries and they will appear here.",
        markAllReadDescription: "all feeds",
      };
    }

    // Default fallback to /all
    return {
      viewId: "all" as const,
      filters: {},
      title: "All Items",
      emptyMessageUnread: "No unread entries. Toggle to show all items.",
      emptyMessageAll: "No entries yet. Subscribe to some feeds to see entries here.",
      markAllReadDescription: "all feeds",
    };
  }, [pathname]);
}

/**
 * Title component for subscription pages. Non-suspending (to avoid React's
 * 300ms fallback throttle): renders a deterministic skeleton until hydrated,
 * then the title from subscriptions.get, falling back to the sidebar list cache
 * so the real title shows even before subscriptions.get resolves.
 */
function SubscriptionTitle({ subscriptionId }: { subscriptionId: string }) {
  const isHydrated = useIsHydrated();
  const queryClient = useQueryClient();
  const { data: subscription } = trpc.subscriptions.get.useQuery(
    { id: subscriptionId },
    { throwOnError: true }
  );

  if (!isHydrated) {
    return <TitleSkeleton />;
  }
  if (subscription) {
    return (
      <TitleText>{subscription.title ?? subscription.originalTitle ?? "Untitled Feed"}</TitleText>
    );
  }
  // Not loaded yet — show the title from the sidebar list cache if present.
  const cached = findCachedSubscription(queryClient, subscriptionId);
  if (cached) {
    return <TitleText>{cached.title ?? cached.originalTitle ?? "Untitled Feed"}</TitleText>;
  }
  return <TitleSkeleton />;
}

/**
 * Title component for tag pages. Non-suspending: deterministic skeleton until
 * hydrated, then the tag name from the (globally prefetched) tags.list cache.
 */
function TagTitle({ tagId }: { tagId: string }) {
  const isHydrated = useIsHydrated();
  const { data: tagsData } = trpc.tags.list.useQuery(undefined, { throwOnError: true });

  if (!isHydrated || !tagsData) {
    return <TitleSkeleton />;
  }
  const tag = tagsData.items.find((t) => t.id === tagId);
  return <TitleText>{tag?.name ?? "Unknown Tag"}</TitleText>;
}

/**
 * Title component that handles all route types. Static titles render
 * immediately; subscription/tag titles render their own non-suspending loading
 * state (deterministic skeleton until hydrated, then cached title).
 */
function EntryListTitle({ routeInfo }: { routeInfo: RouteInfo }) {
  // Static title - render immediately
  if (routeInfo.title !== null) {
    return <TitleText>{routeInfo.title}</TitleText>;
  }

  if (routeInfo.subscriptionId) {
    return <SubscriptionTitle subscriptionId={routeInfo.subscriptionId} />;
  }

  if (routeInfo.tagId) {
    return <TagTitle tagId={routeInfo.tagId} />;
  }

  return <TitleText>All Items</TitleText>;
}

/**
 * Inner content component that renders based on route.
 * Title, entry content, and entry list each render their own non-suspending
 * inline loading state (no Suspense boundaries).
 */
function UnifiedEntriesContentInner() {
  const routeInfo = useRouteInfo();
  const queryClient = useQueryClient();
  const { showUnreadOnly } = useUrlViewPreferences();
  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();

  // Get query input based on current URL - shared with EntryListContainer
  const queryInput = useEntriesListInput();

  // Non-suspending query for navigation - shares cache with EntryListContainer
  const entriesQuery = trpc.entries.list.useInfiniteQuery(queryInput, {
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Fetch subscription data for validation. A genuinely missing subscription
  // throws NOT_FOUND, which we render as a NotFoundCard below; any other error
  // is transient and rethrown to the ErrorBoundary (retryable) instead of
  // showing a misleading "not found" message.
  const subscriptionQuery = trpc.subscriptions.get.useQuery(
    { id: routeInfo.subscriptionId ?? "" },
    {
      enabled: !!routeInfo.subscriptionId,
      throwOnError: (error) => error.data?.code !== "NOT_FOUND",
    }
  );

  // Fetch tag data for validation and empty message customization. tags.list
  // returns a list, so a missing tag is "loaded but absent" (handled below);
  // real fetch errors surface to the ErrorBoundary.
  const tagsQuery = trpc.tags.list.useQuery(undefined, {
    enabled: !!routeInfo.tagId,
    throwOnError: true,
  });

  // Update empty messages with actual tag name if available
  const emptyMessages = useMemo(() => {
    if (routeInfo.tagId && tagsQuery.data) {
      const tag = tagsQuery.data.items.find((t) => t.id === routeInfo.tagId);
      const tagName = tag?.name ?? "this tag";
      return {
        emptyMessageUnread: `No unread entries from feeds tagged with "${tagName}". Toggle to show all items.`,
        emptyMessageAll: `No entries from feeds tagged with "${tagName}" yet.`,
        markAllReadDescription: tag?.name ? `the "${tag.name}" tag` : "this tag",
      };
    }
    return {
      emptyMessageUnread: routeInfo.emptyMessageUnread,
      emptyMessageAll: routeInfo.emptyMessageAll,
      markAllReadDescription: routeInfo.markAllReadDescription,
    };
  }, [routeInfo, tagsQuery.data]);

  // Build mark all read options
  const markAllReadOptions = useMemo(() => {
    const options: Record<string, unknown> = {};
    if (routeInfo.filters.subscriptionId) {
      options.subscriptionId = routeInfo.filters.subscriptionId;
    }
    if (routeInfo.filters.tagId) {
      options.tagId = routeInfo.filters.tagId;
    }
    if (routeInfo.filters.uncategorized) {
      options.uncategorized = true;
    }
    if (routeInfo.filters.starredOnly) {
      options.starredOnly = true;
    }
    if (routeInfo.filters.type) {
      options.type = routeInfo.filters.type;
    }
    return options;
  }, [routeInfo.filters]);

  // Get adjacent entry IDs from query data for navigation
  // Also compute distance to end for pagination triggering
  const pages = entriesQuery.data?.pages;
  const { nextEntryId, previousEntryId, distanceToEnd } = useMemo(() => {
    if (!openEntryId || !pages) {
      return { nextEntryId: undefined, previousEntryId: undefined, distanceToEnd: Infinity };
    }
    const allEntries = pages.flatMap((page) => page.items);
    const currentIndex = allEntries.findIndex((e) => e.id === openEntryId);
    if (currentIndex === -1) {
      return { nextEntryId: undefined, previousEntryId: undefined, distanceToEnd: Infinity };
    }
    return {
      nextEntryId:
        currentIndex < allEntries.length - 1 ? allEntries[currentIndex + 1].id : undefined,
      previousEntryId: currentIndex > 0 ? allEntries[currentIndex - 1].id : undefined,
      distanceToEnd: allEntries.length - 1 - currentIndex,
    };
  }, [openEntryId, pages]);

  // Trigger pagination when navigating close to the end of loaded entries
  // This ensures swipe navigation can continue beyond the initial page
  const prevDistanceToEnd = useRef(distanceToEnd);
  useEffect(() => {
    const PAGINATION_THRESHOLD = 3;
    if (
      distanceToEnd <= PAGINATION_THRESHOLD &&
      distanceToEnd < prevDistanceToEnd.current &&
      entriesQuery.hasNextPage &&
      !entriesQuery.isFetchingNextPage
    ) {
      // Re-assert read/starred from entries.get after the fetch settles: the
      // completing next-page fetch replaces the pages snapshot and would clobber
      // writes applied mid-fetch, e.g. auto-mark-read from swipe/j-k (#1081).
      void entriesQuery.fetchNextPage().then(() => {
        reconcileListReadStarredFromEntryGet(queryClient);
      });
    }
    prevDistanceToEnd.current = distanceToEnd;
  }, [distanceToEnd, entriesQuery, queryClient]);

  // Navigation callbacks - just update URL, React re-renders
  const handleSwipeNext = useMemo(() => {
    if (!nextEntryId) return undefined;
    return () => setOpenEntryId(nextEntryId);
  }, [nextEntryId, setOpenEntryId]);

  const handleSwipePrevious = useMemo(() => {
    if (!previousEntryId) return undefined;
    return () => setOpenEntryId(previousEntryId);
  }, [previousEntryId, setOpenEntryId]);

  // Show "not found" only for a genuine NOT_FOUND; transient errors are
  // rethrown to the ErrorBoundary by throwOnError above.
  if (routeInfo.subscriptionId && subscriptionQuery.error?.data?.code === "NOT_FOUND") {
    return (
      <NotFoundCard
        title="Subscription not found"
        message="The subscription you're looking for doesn't exist or you're not subscribed to it."
      />
    );
  }

  // Show error if the tag list loaded but doesn't contain this tag. Fetch
  // errors are handled by throwOnError above, not this branch.
  if (
    routeInfo.tagId &&
    tagsQuery.data &&
    !tagsQuery.data.items.find((t) => t.id === routeInfo.tagId)
  ) {
    return (
      <NotFoundCard title="Tag not found" message="The tag you're looking for doesn't exist." />
    );
  }

  // Title renders its own inline loading fallback (no Suspense)
  const titleSlot = <EntryListTitle routeInfo={routeInfo} />;

  // Entry content - renders its own inline loading fallback (no Suspense)
  const entryContentSlot = openEntryId ? (
    <EntryContent
      key={openEntryId}
      entryId={openEntryId}
      onBack={closeEntry}
      onSwipeNext={handleSwipeNext}
      onSwipePrevious={handleSwipePrevious}
      nextEntryId={nextEntryId}
      previousEntryId={previousEntryId}
    />
  ) : null;

  // Entry list - renders its own inline loading fallback (no Suspense)
  const entryListSlot = (
    <EntryListContainer
      emptyMessage={
        showUnreadOnly ? emptyMessages.emptyMessageUnread : emptyMessages.emptyMessageAll
      }
    />
  );

  return (
    <EntryPageLayout
      titleSlot={titleSlot}
      entryContentSlot={entryContentSlot}
      entryListSlot={entryListSlot}
      markAllReadDescription={emptyMessages.markAllReadDescription}
      markAllReadOptions={markAllReadOptions}
      hideSortToggle={routeInfo.hideSortToggle}
    />
  );
}

/**
 * Unified entry content component.
 *
 * This single component handles all entry list pages by reading the current URL
 * to determine what to render. When navigation happens via pushState, usePathname()
 * updates and this component re-renders with the appropriate content.
 *
 * Note: No Suspense is used. The title, entry list, and entry content each use
 * non-suspending queries and render their own inline loading fallback, to avoid
 * React's 300ms fallback throttle on warm-cache navigations. An ErrorBoundary
 * (with throwOnError on the queries) handles load failures.
 */
export function UnifiedEntriesContent() {
  return (
    <ErrorBoundary message="Failed to load entries">
      <UnifiedEntriesContentInner />
    </ErrorBoundary>
  );
}
