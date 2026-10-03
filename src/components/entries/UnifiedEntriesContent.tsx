/**
 * UnifiedEntriesContent Component
 *
 * A single client component that handles all entry list pages by reading
 * the current URL to determine what to render. This enables client-side
 * navigation via pushState without triggering SSR.
 *
 * When the URL changes via pushState, useAppPathname() updates, which causes
 * this component to re-derive filters and render the appropriate content.
 *
 * Server components still handle prefetching via EntryListPage - this just
 * unifies the client-side rendering.
 */

"use client";

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EntryPageLayout, TitleSkeleton, TitleText } from "./EntryPageLayout";
import { EntryContent } from "./EntryContent";
import { EntryListContainer, findAdjacentEntries } from "./EntryListContainer";
import { FeedSiteLink } from "@/components/feeds/FeedSiteLink";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { NotFoundCard } from "@/components/ui/not-found-card";
import { useEntryUrlState } from "@/lib/hooks/useEntryUrlState";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
import { useEntriesListInput } from "@/lib/hooks/useEntriesListInput";
import { useEntryListEntries } from "@/lib/hooks/useLocalEntries";
import { getFiltersFromPathname } from "@/lib/queries/entries-list-input";
import { useCanRenderFromCache } from "@/lib/hooks/useIsHydrated";
import { useAppPathname } from "@/lib/hooks/useAppLocation";
import { extractParamsFromPathname } from "@/lib/navigation";
import { type ViewType } from "@/lib/hooks/viewPreferences";
import { trpc } from "@/lib/trpc/client";
import { findCachedSubscription } from "@/lib/cache/count-cache";
import { type MarkAllReadOptions } from "@/lib/hooks/useEntryMutations";

/**
 * Route info derived from the current pathname.
 */
interface RouteInfo {
  viewId: ViewType;
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
  /**
   * Description for mark all read dialog; null hides the button where it has no
   * sensible scope (Recently Read lists entries from every feed, so it would
   * mark the whole library read).
   */
  markAllReadDescription: string | null;
}

const ALL_ROUTE: RouteInfo = {
  viewId: "all",
  title: "All Items",
  emptyMessageUnread: "No unread entries. Toggle to show all items.",
  emptyMessageAll: "No entries yet. Subscribe to some feeds to see entries here.",
  markAllReadDescription: "all feeds",
};

const UNCATEGORIZED_ROUTE: RouteInfo = {
  viewId: "uncategorized",
  title: "Uncategorized",
  emptyMessageUnread: "No unread entries from uncategorized feeds. Toggle to show all items.",
  emptyMessageAll: "No entries from uncategorized feeds yet.",
  markAllReadDescription: "uncategorized feeds",
};

const STATIC_ROUTES: Record<string, RouteInfo> = {
  "/all": ALL_ROUTE,
  "/starred": {
    viewId: "starred",
    title: "Starred",
    emptyMessageUnread: "No unread starred entries. Toggle to show all starred items.",
    emptyMessageAll: "No starred entries yet. Star entries to save them for later.",
    markAllReadDescription: "starred entries",
  },
  "/saved": {
    viewId: "saved",
    title: "Saved",
    emptyMessageUnread: "No unread saved articles. Toggle to show all items.",
    emptyMessageAll: "No saved articles yet. Save articles to read them later.",
    markAllReadDescription: "saved articles",
  },
  "/uncategorized": UNCATEGORIZED_ROUTE,
  "/recently-read": {
    viewId: "recently-read",
    title: "Recently Read",
    emptyMessageUnread: "No unread entries. Toggle to show all items.",
    emptyMessageAll: "No recently read entries yet. Read some entries and they will appear here.",
    markAllReadDescription: null,
  },
};

/**
 * Parse the current pathname to derive route info (titles and empty/mark-all-read
 * copy). The query filters for a route come from `getFiltersFromPathname`, which
 * is their single source of truth.
 */
function useRouteInfo(): RouteInfo {
  const pathname = useAppPathname();

  return useMemo(() => {
    if (Object.hasOwn(STATIC_ROUTES, pathname)) return STATIC_ROUTES[pathname];

    const { subscriptionId, tagId } = extractParamsFromPathname(pathname);
    if (subscriptionId) {
      return {
        viewId: "subscription",
        title: null, // Fetched from API
        subscriptionId,
        emptyMessageUnread: "No unread entries in this subscription. Toggle to show all items.",
        emptyMessageAll:
          "No entries in this subscription yet. Entries will appear here once the feed is fetched.",
        markAllReadDescription: "this subscription",
      };
    }

    // The "uncategorized" pseudo-tag
    if (tagId === "uncategorized") return UNCATEGORIZED_ROUTE;
    if (tagId) {
      return {
        viewId: "tag",
        title: null, // Fetched from API
        tagId,
        emptyMessageUnread: "No unread entries from this tag. Toggle to show all items.",
        emptyMessageAll: "No entries from this tag yet.",
        markAllReadDescription: "this tag",
      };
    }

    return ALL_ROUTE;
  }, [pathname]);
}

/**
 * Title component for subscription pages. Non-suspending (to avoid React's
 * 300ms fallback throttle): renders a deterministic skeleton until hydrated,
 * then the title from subscriptions.get, falling back to the sidebar list cache
 * so the real title shows even before subscriptions.get resolves. Renders the
 * feed's website link beneath the title when the feed advertises one.
 */
function SubscriptionTitle({ subscriptionId }: { subscriptionId: string }) {
  const canRenderFromCache = useCanRenderFromCache();
  const queryClient = useQueryClient();
  const { data: subscription } = trpc.subscriptions.get.useQuery(
    { id: subscriptionId },
    { throwOnError: true }
  );

  if (!canRenderFromCache) {
    return <TitleSkeleton />;
  }
  // Prefer the freshly fetched subscription; fall back to the sidebar list cache
  // so the real title shows even before subscriptions.get resolves.
  const sub = subscription ?? findCachedSubscription(queryClient, subscriptionId);
  if (!sub) {
    return <TitleSkeleton />;
  }
  return (
    <div className="min-w-0">
      <TitleText>{sub.title ?? sub.originalTitle ?? "Untitled Feed"}</TitleText>
      <FeedSiteLink siteUrl={sub.siteUrl} className="mt-0.5" />
    </div>
  );
}

/**
 * Title component for tag pages. Non-suspending: deterministic skeleton until
 * hydrated, then the tag name from the (globally prefetched) tags.list cache.
 */
function TagTitle({ tagId }: { tagId: string }) {
  const canRenderFromCache = useCanRenderFromCache();
  const { data: tagsData } = trpc.tags.list.useQuery(undefined, { throwOnError: true });

  if (!canRenderFromCache || !tagsData) {
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
  if (routeInfo.subscriptionId) {
    return <SubscriptionTitle subscriptionId={routeInfo.subscriptionId} />;
  }
  if (routeInfo.tagId) {
    return <TagTitle tagId={routeInfo.tagId} />;
  }
  // Static title - render immediately
  return <TitleText>{routeInfo.title}</TitleText>;
}

/**
 * Inner content component that renders based on route.
 * Title, entry content, and entry list each render their own non-suspending
 * inline loading state (no Suspense boundaries).
 */
function UnifiedEntriesContentInner() {
  const pathname = useAppPathname();
  const routeInfo = useRouteInfo();
  const { showUnreadOnly, searchQuery } = useUrlViewPreferences();
  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();

  // Get query input based on current URL - shared with EntryListContainer
  const queryInput = useEntriesListInput();

  // Keeps the list's query observed while an entry is open (EntryListContainer
  // owns fetching); the entries themselves come from the local store.
  trpc.entries.list.useInfiniteQuery(queryInput, {
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const entries = useEntryListEntries(queryInput);

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

  // Mark-all-read acts on the current view, so it reuses the route's query
  // filters. `sortBy` only orders the list, so it isn't one of them.
  const markAllReadOptions = useMemo<MarkAllReadOptions>(() => {
    const { subscriptionId, tagId, uncategorized, starredOnly, type } =
      getFiltersFromPathname(pathname);
    return { subscriptionId, tagId, uncategorized, starredOnly, type };
  }, [pathname]);

  // Adjacent entry IDs for swipe navigation. Pagination near the end of the
  // loaded entries is triggered by EntryListContainer, which owns the query.
  const { nextEntryId, previousEntryId } = useMemo(
    () => findAdjacentEntries(entries, openEntryId),
    [openEntryId, entries]
  );

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
  const emptyMessage = searchQuery
    ? showUnreadOnly
      ? `No unread entries matching "${searchQuery}". Toggle to search read items too.`
      : `No entries matching "${searchQuery}".`
    : showUnreadOnly
      ? emptyMessages.emptyMessageUnread
      : emptyMessages.emptyMessageAll;
  const entryListSlot = <EntryListContainer emptyMessage={emptyMessage} />;

  return (
    <EntryPageLayout
      titleSlot={titleSlot}
      entryContentSlot={entryContentSlot}
      entryListSlot={entryListSlot}
      markAllReadDescription={emptyMessages.markAllReadDescription}
      markAllReadOptions={markAllReadOptions}
    />
  );
}

/**
 * Unified entry content component.
 *
 * This single component handles all entry list pages by reading the current URL
 * to determine what to render. When navigation happens via pushState, useAppPathname()
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
