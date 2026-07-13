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
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ClientLink } from "@/components/ui/client-link";
import { SpinnerIcon, GoogleIcon, AppleIcon, DiscordIcon } from "@/components/ui/icon-button";

// ============================================================================
// Constants
// ============================================================================

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;

// Sort options for the user list. Values must match the admin.listUsers `sort`
// enum on the backend.
type UserSort = "activity" | "created" | "oldest" | "email";

const SORT_OPTIONS: { value: UserSort; label: string }[] = [
  { value: "activity", label: "Most recent activity" },
  { value: "created", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "email", label: "Email (A–Z)" },
];

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
      <span className="ui-text-xs bg-surface-muted text-muted inline-flex items-center rounded-full px-2 py-0.5 font-medium">
        {provider}
      </span>
    );
  }

  const Icon = config.icon;
  return (
    <span className="ui-text-xs bg-surface-muted text-muted inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium">
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
  lastActiveAt: Date | null;
  lastTokenUsedAt: Date | null;
  providers: string[];
  subscriptionCount: number;
  entryCount: number;
}

function UserRow({ user }: { user: User }) {
  return (
    <div className="border-edge flex flex-col gap-2 border-b p-4 last:border-b-0">
      {/* Email and ID */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="ui-text-sm text-strong font-medium">{user.email}</span>
        <code className="ui-text-xs text-faint font-mono">{truncateId(user.id)}</code>
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
      <div className="ui-text-xs text-muted flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
        <span>Member since {formatDate(user.createdAt)}</span>
        <span>Last active: {user.lastActiveAt ? formatDate(user.lastActiveAt) : "Never"}</span>
        <span>
          Last API/MCP use: {user.lastTokenUsedAt ? formatDate(user.lastTokenUsedAt) : "Never"}
        </span>
        <span>
          Subscriptions:{" "}
          <ClientLink
            href={`/admin/feeds?userEmail=${encodeURIComponent(user.email)}`}
            className="text-accent hover:text-accent-hover underline"
          >
            {user.subscriptionCount}
          </ClientLink>
        </span>
        <span>Entries: {user.entryCount.toLocaleString()}</span>
      </div>
    </div>
  );
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState({ hasSearch }: { hasSearch: boolean }) {
  return (
    <div className="p-8 text-center">
      <h3 className="ui-text-sm text-strong font-medium">
        {hasSearch ? "No matching users" : "No users yet"}
      </h3>
      <p className="ui-text-sm text-muted mt-1">
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
  const [sort, setSort] = useState<UserSort>("activity");
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
      sort,
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
        <h2 className="ui-text-lg text-strong font-semibold">Users</h2>
      </div>

      {/* Search + sort */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex-1">
          <Input
            id="user-search"
            placeholder="Search by email..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label htmlFor="user-sort" className="ui-text-sm text-muted">
            Sort by
          </label>
          <select
            id="user-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as UserSort)}
            className="ui-text-sm bg-surface text-strong border-edge-input focus:border-focus focus:ring-focus block rounded-md border px-3 py-2 focus:ring-2 focus:ring-offset-2 focus:outline-none"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Users List */}
      {usersQuery.isLoading ? (
        <div className="flex items-center justify-center p-8">
          <SpinnerIcon className="text-faint h-6 w-6" />
        </div>
      ) : usersQuery.isError ? (
        <div className="p-8 text-center">
          <p className="ui-text-sm text-danger">Failed to load users. Please try again.</p>
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
        <Card padding="none">
          {users.map((user) => (
            <UserRow key={user.id} user={user} />
          ))}

          {/* Load more trigger element */}
          <div ref={loadMoreRef} className="h-1" />

          {/* Loading indicator */}
          {usersQuery.isFetchingNextPage && (
            <div className="flex items-center justify-center p-4">
              <SpinnerIcon className="text-faint mr-2 h-4 w-4" />
              <span className="ui-text-sm text-muted">Loading more...</span>
            </div>
          )}

          {/* End of list */}
          {!usersQuery.hasNextPage && users.length > 0 && (
            <p className="ui-text-xs text-faint p-3 text-center">No more users</p>
          )}
        </Card>
      )}
    </div>
  );
}
