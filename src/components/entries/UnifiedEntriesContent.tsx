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

import { Suspense, useMemo, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { EntryPageLayout, TitleSkeleton, TitleText } from "./EntryPageLayout";
import { EntryContent } from "./EntryContent";
import { SuspendingEntryList } from "./SuspendingEntryList";
import { EntryListFallback } from "./EntryListFallback";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { NotFoundCard } from "@/components/ui";
import { useEntryUrlState } from "@/lib/hooks/useEntryUrlState";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
import { useEntriesListInput } from "@/lib/hooks/useEntriesListInput";
import { type ViewType } from "@/lib/hooks/viewPreferences";
import { trpc } from "@/lib/trpc/client";
import { findCachedSubscription } from "@/lib/cache";
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
  };
  /** Static title (null means we need to fetch it) */
  title: string | null;
  /** Whether this route needs to fetch a subscription for its title */
  subscriptionId?: string;
  /** Whether this route needs to fetch a tag for its title */
  tagId?: string;
  /** Whether to show the file upload button */
  showUploadButton?: boolean;
  /** Empty message when showing unread only */
  emptyMessageUnread: string;
  /** Empty message when showing all entries */
  emptyMessageAll: string;
  /** Description for mark all read dialog */
  markAllReadDescription: string;
}

/**
 * Extract params from pathname.
 * We can't use useParams() because it doesn't update on pushState navigation.
 */
function extractParamsFromPathname(pathname: string): { id?: string; tagId?: string } {
  // /subscription/:id
  const subscriptionMatch = pathname.match(/^\/subscription\/([^/]+)/);
  if (subscriptionMatch) {
    return { id: subscriptionMatch[1] };
  }

  // /tag/:tagId
  const tagMatch = pathname.match(/^\/tag\/([^/]+)/);
  if (tagMatch) {
    return { tagId: tagMatch[1] };
  }

  return {};
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
        showUploadButton: true,
        emptyMessageUnread: "No unread saved articles. Toggle to show all items.",
        emptyMessageAll: "No saved articles yet. Save articles to read them later.",
        markAllReadDescription: "saved articles",
      };
    }

    // /subscription/:id - Single subscription entries
    if (pathname.startsWith("/subscription/") && params.id) {
      const subscriptionId = params.id;
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
    if (pathname.startsWith("/tag/") && params.tagId) {
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
 * Title component for subscription pages.
 * Uses useSuspenseQuery so it suspends until data is available.
 */
function SubscriptionTitle({ subscriptionId }: { subscriptionId: string }) {
  const [subscription] = trpc.subscriptions.get.useSuspenseQuery({ id: subscriptionId });
  if (!subscription) {
    // This shouldn't happen with suspense, but handle it gracefully
    return <TitleText>Untitled Feed</TitleText>;
  }
  return (
    <TitleText>{subscription.title ?? subscription.originalTitle ?? "Untitled Feed"}</TitleText>
  );
}

/**
 * Title component for tag pages.
 * Uses useSuspenseQuery so it suspends until data is available.
 */
function TagTitle({ tagId }: { tagId: string }) {
  const [tagsData] = trpc.tags.list.useSuspenseQuery();
  const tag = tagsData?.items.find((t) => t.id === tagId);
  return <TitleText>{tag?.name ?? "Unknown Tag"}</TitleText>;
}

/**
 * Title component that handles all route types.
 * Static titles render immediately; dynamic titles suspend until data loads.
 */
function EntryListTitle({ routeInfo }: { routeInfo: RouteInfo }) {
  // Static title - render immediately
  if (routeInfo.title !== null) {
    return <TitleText>{routeInfo.title}</TitleText>;
  }

  // Subscription title - suspends until subscription data loads
  if (routeInfo.subscriptionId) {
    return <SubscriptionTitle subscriptionId={routeInfo.subscriptionId} />;
  }

  // Tag title - suspends until tags data loads
  if (routeInfo.tagId) {
    return <TagTitle tagId={routeInfo.tagId} />;
  }

  return <TitleText>All Items</TitleText>;
}

/**
 * Smart title fallback that tries to show cached title instead of skeleton.
 * Used as the Suspense fallback for the title slot.
 */
function TitleFallback({ routeInfo }: { routeInfo: RouteInfo }) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  // Static title - render immediately (shouldn't suspend anyway, but handle it)
  if (routeInfo.title !== null) {
    return <TitleText>{routeInfo.title}</TitleText>;
  }

  // Subscription title from cache
  if (routeInfo.subscriptionId) {
    const subscription = findCachedSubscription(utils, queryClient, routeInfo.subscriptionId);
    if (subscription) {
      return (
        <TitleText>{subscription.title ?? subscription.originalTitle ?? "Untitled Feed"}</TitleText>
      );
    }
    return <TitleSkeleton />;
  }

  // Tag title from cache
  if (routeInfo.tagId) {
    const tagsData = utils.tags.list.getData();
    const tag = tagsData?.items.find((t) => t.id === routeInfo.tagId);
    if (tag) {
      return <TitleText>{tag.name}</TitleText>;
    }
    return <TitleSkeleton />;
  }

  return <TitleText>All Items</TitleText>;
}

/**
 * Inner content component that renders based on route.
 * Entry content and entry list have independent Suspense boundaries.
 */
function UnifiedEntriesContentInner() {
  const routeInfo = useRouteInfo();
  const { showUnreadOnly } = useUrlViewPreferences();
  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();

  // Get query input based on current URL - shared with SuspendingEntryList
  const queryInput = useEntriesListInput();

  // Non-suspending query for navigation - shares cache with SuspendingEntryList
  const entriesQuery = trpc.entries.list.useInfiniteQuery(queryInput, {
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Fetch subscription data for validation
  const subscriptionQuery = trpc.subscriptions.get.useQuery(
    { id: routeInfo.subscriptionId ?? "" },
    { enabled: !!routeInfo.subscriptionId }
  );

  // Fetch tag data for validation and empty message customization
  const tagsQuery = trpc.tags.list.useQuery(undefined, {
    enabled: !!routeInfo.tagId,
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
      entriesQuery.fetchNextPage();
    }
    prevDistanceToEnd.current = distanceToEnd;
  }, [distanceToEnd, entriesQuery]);

  // Navigation callbacks - just update URL, React re-renders
  const handleSwipeNext = useMemo(() => {
    if (!nextEntryId) return undefined;
    return () => setOpenEntryId(nextEntryId);
  }, [nextEntryId, setOpenEntryId]);

  const handleSwipePrevious = useMemo(() => {
    if (!previousEntryId) return undefined;
    return () => setOpenEntryId(previousEntryId);
  }, [previousEntryId, setOpenEntryId]);

  // Show error if subscription query completed but subscription not found
  if (routeInfo.subscriptionId && !subscriptionQuery.isLoading && !subscriptionQuery.data) {
    return (
      <NotFoundCard
        title="Subscription not found"
        message="The subscription you're looking for doesn't exist or you're not subscribed to it."
      />
    );
  }

  // Show error if tag query completed but tag not found
  if (
    routeInfo.tagId &&
    !tagsQuery.isLoading &&
    !tagsQuery.data?.items.find((t) => t.id === routeInfo.tagId)
  ) {
    return (
      <NotFoundCard title="Tag not found" message="The tag you're looking for doesn't exist." />
    );
  }

  // Title has its own Suspense boundary with smart fallback that uses cache
  const titleSlot = (
    <Suspense fallback={<TitleFallback routeInfo={routeInfo} />}>
      <EntryListTitle routeInfo={routeInfo} />
    </Suspense>
  );

  // Entry content - has its own internal Suspense boundary
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

  // Entry list - has its own Suspense boundary
  const entryListSlot = (
    <Suspense
      fallback={
        <EntryListFallback
          filters={{
            subscriptionId: queryInput.subscriptionId,
            tagId: queryInput.tagId,
            uncategorized: queryInput.uncategorized,
            starredOnly: queryInput.starredOnly,
            type: queryInput.type,
            unreadOnly: queryInput.unreadOnly,
            sortOrder: queryInput.sortOrder,
          }}
          skeletonCount={5}
        />
      }
    >
      <SuspendingEntryList
        emptyMessage={
          showUnreadOnly ? emptyMessages.emptyMessageUnread : emptyMessages.emptyMessageAll
        }
      />
    </Suspense>
  );

  return (
    <EntryPageLayout
      titleSlot={titleSlot}
      entryContentSlot={entryContentSlot}
      entryListSlot={entryListSlot}
      markAllReadDescription={emptyMessages.markAllReadDescription}
      markAllReadOptions={markAllReadOptions}
      showUploadButton={routeInfo.showUploadButton}
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
 * Note: No outer Suspense needed because UnifiedEntriesContentInner uses only
 * non-suspending queries. All suspending queries are inside child components
 * with their own Suspense boundaries (title, entry list, entry content).
 */
export function UnifiedEntriesContent() {
  return (
    <ErrorBoundary message="Failed to load entries">
      <UnifiedEntriesContentInner />
    </ErrorBoundary>
  );
}
