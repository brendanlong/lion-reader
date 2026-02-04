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

import { Suspense, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { EntryPageLayout } from "./EntryPageLayout";
import { EntryListFallback } from "./EntryListFallback";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { NotFoundCard } from "@/components/ui";
import { useEntryPage, type UseEntryPageOptions } from "@/lib/hooks";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
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
 * Inner content component that renders based on route.
 */
function UnifiedEntriesContentInner() {
  const routeInfo = useRouteInfo();
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  // Build useEntryPage options
  const pageOptions: UseEntryPageOptions = useMemo(
    () => ({
      viewId: routeInfo.viewId,
      viewScopeId: routeInfo.subscriptionId ?? routeInfo.tagId,
      filters: routeInfo.filters,
    }),
    [routeInfo.viewId, routeInfo.subscriptionId, routeInfo.tagId, routeInfo.filters]
  );

  const page = useEntryPage(pageOptions);

  // Fetch subscription data if needed (for title)
  const getPlaceholderData = useCallback(() => {
    if (!routeInfo.subscriptionId) return undefined;
    return findCachedSubscription(utils, queryClient, routeInfo.subscriptionId);
  }, [utils, queryClient, routeInfo.subscriptionId]);

  const subscriptionQuery = trpc.subscriptions.get.useQuery(
    { id: routeInfo.subscriptionId ?? "" },
    {
      enabled: !!routeInfo.subscriptionId,
      placeholderData: getPlaceholderData,
    }
  );

  // Fetch tag data if needed (for title)
  const tagsQuery = trpc.tags.list.useQuery(undefined, {
    enabled: !!routeInfo.tagId,
  });

  // Derive title based on route
  const title = useMemo(() => {
    // Static title
    if (routeInfo.title !== null) {
      return routeInfo.title;
    }

    // Subscription title
    if (routeInfo.subscriptionId) {
      const subscription = subscriptionQuery.data;
      if (subscription) {
        return subscription.title ?? subscription.originalTitle ?? "Untitled Feed";
      }
      return null; // Still loading
    }

    // Tag title
    if (routeInfo.tagId) {
      const tag = tagsQuery.data?.items.find((t) => t.id === routeInfo.tagId);
      if (tag) {
        return tag.name;
      }
      if (!tagsQuery.isLoading) {
        return null; // Tag not found, will show error below
      }
      return null; // Still loading
    }

    return "All Items";
  }, [routeInfo, subscriptionQuery.data, tagsQuery.data, tagsQuery.isLoading]);

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

  return (
    <EntryPageLayout
      page={page}
      title={title}
      emptyMessageUnread={emptyMessages.emptyMessageUnread}
      emptyMessageAll={emptyMessages.emptyMessageAll}
      markAllReadDescription={emptyMessages.markAllReadDescription}
      markAllReadOptions={markAllReadOptions}
      showUploadButton={routeInfo.showUploadButton}
    />
  );
}

/**
 * Fallback component that shows cached entries or skeleton.
 * Reads URL to match the filters the main component will use.
 */
function UnifiedEntriesFallback() {
  const routeInfo = useRouteInfo();
  const { showUnreadOnly, sortOrder } = useUrlViewPreferences();

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 sm:mb-6">
        <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
      <EntryListFallback
        filters={{ ...routeInfo.filters, unreadOnly: showUnreadOnly, sortOrder }}
        skeletonCount={5}
      />
    </div>
  );
}

/**
 * Unified entry content component.
 *
 * This single component handles all entry list pages by reading the current URL
 * to determine what to render. When navigation happens via pushState, usePathname()
 * updates and this component re-renders with the appropriate content.
 */
export function UnifiedEntriesContent() {
  return (
    <ErrorBoundary message="Failed to load entries">
      <Suspense fallback={<UnifiedEntriesFallback />}>
        <UnifiedEntriesContentInner />
      </Suspense>
    </ErrorBoundary>
  );
}
