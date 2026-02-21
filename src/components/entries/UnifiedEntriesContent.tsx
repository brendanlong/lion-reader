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

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { EntryPageLayout, TitleSkeleton } from "./EntryPageLayout";
import { EntryContent } from "./EntryContent";
import { EntryListSkeleton } from "./EntryListSkeleton";

// SuspendingEntryList uses useLiveInfiniteQuery (TanStack DB) which calls useSyncExternalStore
// without getServerSnapshot, causing SSR to crash. Disable SSR since the on-demand
// collection is client-only state.
const SuspendingEntryList = dynamic(
  () => import("./SuspendingEntryList").then((m) => m.SuspendingEntryList),
  { ssr: false, loading: () => <EntryListSkeleton count={5} /> }
);
// EntryListTitle uses useLiveQuery for reactive collection reads, which also
// uses useSyncExternalStore without getServerSnapshot. Disable SSR.
const EntryListTitle = dynamic(() => import("./EntryListTitle").then((m) => m.EntryListTitle), {
  ssr: false,
  loading: () => <TitleSkeleton />,
});
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { NotFoundCard } from "@/components/ui/not-found-card";
import { useEntryUrlState } from "@/lib/hooks/useEntryUrlState";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
import { type ViewType } from "@/lib/hooks/viewPreferences";
import { trpc } from "@/lib/trpc/client";
import { useCollections } from "@/lib/collections/context";
import { upsertSubscriptionsInCollection } from "@/lib/collections/writes";
import {
  createEntryNavigationStore,
  EntryNavigationProvider,
  useEntryNavigationState,
} from "@/lib/hooks/useEntryNavigation";
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
    sortBy?: "published" | "readChanged" | "predictedScore";
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
  /** Whether to hide the sort toggle (e.g., for algorithmic feed) */
  hideSortToggle?: boolean;
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

    // /best - Algorithmic feed sorted by predicted score
    if (pathname === "/best") {
      return {
        viewId: "best" as const,
        filters: { sortBy: "predictedScore" as const },
        title: "Best",
        hideSortToggle: true,
        emptyMessageUnread: "No unread entries. Toggle to show all items.",
        emptyMessageAll:
          "No entries with predicted scores yet. Score some entries to train the algorithm.",
        markAllReadDescription: "all feeds",
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
 * Inner content component that renders based on route.
 * Titles read from TanStack DB collections; entry list handles its own loading.
 */
function UnifiedEntriesContentInner() {
  const routeInfo = useRouteInfo();
  const { showUnreadOnly } = useUrlViewPreferences();
  const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();

  // Navigation state published by SuspendingEntryList via useEntryNavigationUpdater
  const { nextEntryId, previousEntryId } = useEntryNavigationState();

  const collections = useCollections();

  // Fetch subscription data for validation and to populate the collection for title display
  const subscriptionQuery = trpc.subscriptions.get.useQuery(
    { id: routeInfo.subscriptionId ?? "" },
    { enabled: !!routeInfo.subscriptionId }
  );

  // Upsert subscription into collection so the title renders from the collection
  useEffect(() => {
    if (subscriptionQuery.data) {
      upsertSubscriptionsInCollection(collections, [subscriptionQuery.data]);
    }
  }, [collections, subscriptionQuery.data]);

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

  // Title reactively reads from collections via useLiveQuery
  const titleSlot = <EntryListTitle routeInfo={routeInfo} />;

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

  // Entry list - SuspendingEntryList handles its own loading state;
  // the dynamic() import's loading prop covers the chunk load.
  const entryListSlot = (
    <SuspendingEntryList
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
      showUploadButton={routeInfo.showUploadButton}
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
 * Provides EntryNavigationProvider so SuspendingEntryList can publish
 * next/previous entry IDs for swipe gesture navigation in EntryContent.
 */
export function UnifiedEntriesContent() {
  const [navigationStore] = useState(createEntryNavigationStore);

  return (
    <ErrorBoundary message="Failed to load entries">
      <EntryNavigationProvider value={navigationStore}>
        <UnifiedEntriesContentInner />
      </EntryNavigationProvider>
    </ErrorBoundary>
  );
}
