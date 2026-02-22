/**
 * Admin Users Content
 *
 * Displays a paginated list of all users in the system with search by email.
 * Shows user details including OAuth providers, subscription/entry counts,
 * scoring model info.
 * Uses infinite scroll for pagination and debounced search for filtering.
 */

"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ClientLink } from "@/components/ui/client-link";
import { SpinnerIcon, GoogleIcon, AppleIcon, DiscordIcon } from "@/components/ui/icon-button";

// ============================================================================
// Constants
// ============================================================================

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;

// ============================================================================
// Helpers
// ============================================================================

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function truncateId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}...`;
}

// ============================================================================
// Provider Badge
// ============================================================================

const providerConfig: Record<string, { icon: typeof GoogleIcon; label: string }> = {
  google: { icon: GoogleIcon, label: "Google" },
  apple: { icon: AppleIcon, label: "Apple" },
  discord: { icon: DiscordIcon, label: "Discord" },
};

function ProviderBadge({ provider }: { provider: string }) {
  const config = providerConfig[provider];
  if (!config) {
    return (
      <span className="ui-text-xs inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
        {provider}
      </span>
    );
  }

  const Icon = config.icon;
  return (
    <span className="ui-text-xs inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  );
}

// ============================================================================
// User Row
// ============================================================================

interface User {
  id: string;
  email: string;
  createdAt: Date;
  providers: string[];
  subscriptionCount: number;
  entryCount: number;
  scoringModelSize: number | null;
  scoringModelMemoryEstimate: number | null;
}

function UserRow({ user }: { user: User }) {
  return (
    <div className="flex flex-col gap-2 border-b border-zinc-200 p-4 last:border-b-0 dark:border-zinc-800">
      {/* Email and ID */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">{user.email}</span>
        <code className="ui-text-xs font-mono text-zinc-400 dark:text-zinc-500">
          {truncateId(user.id)}
        </code>
      </div>

      {/* OAuth providers */}
      {user.providers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {user.providers.map((provider) => (
            <ProviderBadge key={provider} provider={provider} />
          ))}
        </div>
      )}

      {/* Stats row */}
      <div className="ui-text-xs flex flex-wrap gap-x-4 gap-y-1 text-zinc-500 dark:text-zinc-400">
        <span>Member since {formatDate(user.createdAt)}</span>
        <span>
          Subscriptions:{" "}
          <ClientLink
            href={`/admin/feeds?userEmail=${encodeURIComponent(user.email)}`}
            className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            {user.subscriptionCount}
          </ClientLink>
        </span>
        <span>Entries: {user.entryCount.toLocaleString()}</span>
      </div>

      {/* Scoring model info */}
      {user.scoringModelSize != null && (
        <div className="ui-text-xs text-zinc-500 dark:text-zinc-400">
          Scoring model: {formatBytes(user.scoringModelSize)}
          {user.scoringModelMemoryEstimate != null && (
            <span> (est. memory: {formatBytes(user.scoringModelMemoryEstimate)})</span>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState({ hasSearch }: { hasSearch: boolean }) {
  return (
    <div className="p-8 text-center">
      <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">
        {hasSearch ? "No matching users" : "No users yet"}
      </h3>
      <p className="ui-text-sm mt-1 text-zinc-500 dark:text-zinc-400">
        {hasSearch ? "Try a different search term." : "No users have registered yet."}
      </p>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function AdminUsersContent() {
  const searchParams = useSearchParams();
  const initialSearch = searchParams.get("search") ?? "";

  const [searchInput, setSearchInput] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Query: list users with infinite scroll
  const usersQuery = trpc.admin.listUsers.useInfiniteQuery(
    {
      limit: PAGE_SIZE,
      search: debouncedSearch || undefined,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  // Flatten all pages into a single list
  const users = useMemo(
    () => usersQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [usersQuery.data?.pages]
  );

  // Intersection Observer for infinite scroll
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = usersQuery;
  const handleObserver = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const target = entries[0];
      if (target.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage]
  );

  useEffect(() => {
    const observer = new IntersectionObserver(handleObserver, {
      rootMargin: "100px",
      threshold: 0,
    });

    const currentRef = loadMoreRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
    };
  }, [handleObserver]);

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h2 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">Users</h2>
      </div>

      {/* Search */}
      <div className="mb-4">
        <Input
          id="user-search"
          placeholder="Search by email..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>

      {/* Users List */}
      {usersQuery.isLoading ? (
        <div className="flex items-center justify-center p-8">
          <SpinnerIcon className="h-6 w-6 text-zinc-400" />
        </div>
      ) : usersQuery.isError ? (
        <div className="p-8 text-center">
          <p className="ui-text-sm text-red-600 dark:text-red-400">
            Failed to load users. Please try again.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => usersQuery.refetch()}
            className="mt-2"
          >
            Retry
          </Button>
        </div>
      ) : users.length === 0 ? (
        <EmptyState hasSearch={debouncedSearch.length > 0} />
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          {users.map((user) => (
            <UserRow key={user.id} user={user} />
          ))}

          {/* Load more trigger element */}
          <div ref={loadMoreRef} className="h-1" />

          {/* Loading indicator */}
          {usersQuery.isFetchingNextPage && (
            <div className="flex items-center justify-center p-4">
              <SpinnerIcon className="mr-2 h-4 w-4 text-zinc-400" />
              <span className="ui-text-sm text-zinc-500 dark:text-zinc-400">Loading more...</span>
            </div>
          )}

          {/* End of list */}
          {!usersQuery.hasNextPage && users.length > 0 && (
            <p className="ui-text-xs p-3 text-center text-zinc-400 dark:text-zinc-500">
              No more users
            </p>
          )}
        </div>
      )}
    </div>
  );
}
