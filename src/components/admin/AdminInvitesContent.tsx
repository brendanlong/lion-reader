/**
 * Admin Invites Content
 *
 * Displays a paginated list of invites with search, generation, and revocation.
 * Uses infinite scroll for pagination and debounced search for filtering.
 */

"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, StatusCard } from "@/components/ui/card";
import { ClientLink } from "@/components/ui/client-link";
import { CopyIcon, SpinnerIcon } from "@/components/ui/icon-button";

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
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

function truncateToken(token: string): string {
  if (token.length <= 12) return token;
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

// ============================================================================
// Status Badge
// ============================================================================

interface StatusBadgeProps {
  status: "pending" | "used" | "expired";
}

function StatusBadge({ status }: StatusBadgeProps) {
  const styles = {
    pending: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    used: "bg-success-subtle text-success",
    expired: "bg-surface-muted text-muted",
  };

  return (
    <span
      className={`ui-text-xs inline-flex items-center rounded-full px-2 py-0.5 font-medium ${styles[status]}`}
    >
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// ============================================================================
// Created Invite Display
// ============================================================================

interface CreatedInviteProps {
  inviteUrl: string;
  onDismiss: () => void;
}

function CreatedInviteDisplay({ inviteUrl, onDismiss }: CreatedInviteProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      toast.success("Invite URL copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  return (
    <StatusCard variant="info" className="mb-6">
      <div className="flex flex-col gap-2">
        <p className="ui-text-sm text-strong font-medium">Invite created successfully</p>
        <div className="flex items-center gap-2">
          <code className="ui-text-sm flex-1 truncate rounded bg-white/60 px-2 py-1 dark:bg-zinc-800/60">
            {inviteUrl}
          </code>
          <Button variant="secondary" size="sm" onClick={handleCopy} className="shrink-0">
            <CopyIcon className="mr-1 h-3.5 w-3.5" />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <button
          onClick={onDismiss}
          className="ui-text-sm text-muted self-start underline hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          Dismiss
        </button>
      </div>
    </StatusCard>
  );
}

// ============================================================================
// Invite Row
// ============================================================================

interface Invite {
  id: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
  status: "pending" | "used" | "expired";
  usedAt: Date | null;
  usedByEmail: string | null;
}

interface InviteRowProps {
  invite: Invite;
  onRevoke: (inviteId: string) => void;
  isRevoking: boolean;
}

function InviteRow({ invite, onRevoke, isRevoking }: InviteRowProps) {
  return (
    <div className="border-edge flex flex-col gap-2 border-b p-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StatusBadge status={invite.status} />
          <code className="ui-text-sm text-muted">{truncateToken(invite.token)}</code>
        </div>

        <div className="ui-text-xs text-muted mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
          <span>Created: {formatDate(invite.createdAt)}</span>
          <span>Expires: {formatDate(invite.expiresAt)}</span>
          {invite.usedAt && <span>Used: {formatDate(invite.usedAt)}</span>}
        </div>

        {invite.status === "used" && invite.usedByEmail && (
          <p className="ui-text-sm mt-1">
            <span className="text-muted">Used by: </span>
            <ClientLink
              href={`/admin/users?search=${encodeURIComponent(invite.usedByEmail)}`}
              className="text-blue-600 underline hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              {invite.usedByEmail}
            </ClientLink>
          </p>
        )}
      </div>

      {invite.status === "pending" && (
        <div className="shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRevoke(invite.id)}
            loading={isRevoking}
            className="text-danger hover:bg-danger-subtle hover:text-danger-hover"
          >
            Revoke
          </Button>
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
      <h3 className="ui-text-sm text-strong font-medium">
        {hasSearch ? "No matching invites" : "No invites yet"}
      </h3>
      <p className="ui-text-sm text-muted mt-1">
        {hasSearch ? "Try a different search term." : "Generate an invite to get started."}
      </p>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function AdminInvitesContent() {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [createdInviteUrl, setCreatedInviteUrl] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const utils = trpc.useUtils();

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Query: list invites with infinite scroll
  const invitesQuery = trpc.admin.listInvites.useInfiniteQuery(
    {
      limit: PAGE_SIZE,
      search: debouncedSearch || undefined,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  // Flatten all pages into a single list
  const invites = useMemo(
    () => invitesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [invitesQuery.data?.pages]
  );

  // Mutation: create invite
  const createInviteMutation = trpc.admin.createInvite.useMutation({
    onSuccess: (data) => {
      setCreatedInviteUrl(data.inviteUrl);
      utils.admin.listInvites.invalidate();
      toast.success("Invite generated");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create invite");
    },
  });

  // Mutation: revoke invite
  const revokeInviteMutation = trpc.admin.revokeInvite.useMutation({
    onSuccess: () => {
      setRevokingId(null);
      utils.admin.listInvites.invalidate();
      toast.success("Invite revoked");
    },
    onError: (error) => {
      setRevokingId(null);
      toast.error(error.message || "Failed to revoke invite");
    },
  });

  const handleRevoke = useCallback(
    (inviteId: string) => {
      setRevokingId(inviteId);
      revokeInviteMutation.mutate({ inviteId });
    },
    [revokeInviteMutation]
  );

  // Intersection Observer for infinite scroll
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = invitesQuery;
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
      <div className="mb-6 flex items-center justify-between">
        <h2 className="ui-text-lg text-strong font-semibold">Invites</h2>
        <Button
          onClick={() => createInviteMutation.mutate({})}
          loading={createInviteMutation.isPending}
        >
          Generate Invite
        </Button>
      </div>

      {/* Created invite URL display */}
      {createdInviteUrl && (
        <CreatedInviteDisplay
          inviteUrl={createdInviteUrl}
          onDismiss={() => setCreatedInviteUrl(null)}
        />
      )}

      {/* Search */}
      <div className="mb-4">
        <Input
          id="invite-search"
          placeholder="Search by user email..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>

      {/* Invites List */}
      {invitesQuery.isLoading ? (
        <div className="flex items-center justify-center p-8">
          <SpinnerIcon className="h-6 w-6 text-zinc-400" />
        </div>
      ) : invitesQuery.isError ? (
        <div className="p-8 text-center">
          <p className="ui-text-sm text-danger">Failed to load invites. Please try again.</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => invitesQuery.refetch()}
            className="mt-2"
          >
            Retry
          </Button>
        </div>
      ) : invites.length === 0 ? (
        <EmptyState hasSearch={debouncedSearch.length > 0} />
      ) : (
        <Card padding="none">
          {invites.map((invite) => (
            <InviteRow
              key={invite.id}
              invite={invite}
              onRevoke={handleRevoke}
              isRevoking={revokingId === invite.id}
            />
          ))}

          {/* Load more trigger element */}
          <div ref={loadMoreRef} className="h-1" />

          {/* Loading indicator */}
          {invitesQuery.isFetchingNextPage && (
            <div className="flex items-center justify-center p-4">
              <SpinnerIcon className="mr-2 h-4 w-4 text-zinc-400" />
              <span className="ui-text-sm text-muted">Loading more...</span>
            </div>
          )}

          {/* End of list */}
          {!invitesQuery.hasNextPage && invites.length > 0 && (
            <p className="ui-text-xs text-faint p-3 text-center">No more invites</p>
          )}
        </Card>
      )}
    </div>
  );
}
