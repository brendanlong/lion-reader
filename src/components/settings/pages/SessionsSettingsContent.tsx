/**
 * Sessions Page
 *
 * Displays all active sessions for the current user.
 * Allows revoking sessions except the current one.
 */

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { SettingsListContainer } from "@/components/settings/SettingsListContainer";
import { MobileIcon, DesktopIcon } from "@/components/ui/icon-button";
import { formatRelativeTime } from "@/lib/format";

/**
 * Parse user agent string to extract browser and platform info.
 */
function parseUserAgent(userAgent: string | null): { browser: string; platform: string } {
  if (!userAgent) {
    return { browser: "Unknown browser", platform: "Unknown device" };
  }

  let browser = "Unknown browser";
  let platform = "Unknown device";

  // Detect browser
  if (userAgent.includes("Firefox/")) {
    browser = "Firefox";
  } else if (userAgent.includes("Edg/")) {
    browser = "Microsoft Edge";
  } else if (userAgent.includes("Chrome/")) {
    browser = "Chrome";
  } else if (userAgent.includes("Safari/")) {
    browser = "Safari";
  } else if (userAgent.includes("Opera/") || userAgent.includes("OPR/")) {
    browser = "Opera";
  }

  // Detect platform
  if (userAgent.includes("iPhone") || userAgent.includes("iPad")) {
    platform = "iOS";
  } else if (userAgent.includes("Android")) {
    platform = "Android";
  } else if (userAgent.includes("Mac OS")) {
    platform = "macOS";
  } else if (userAgent.includes("Windows")) {
    platform = "Windows";
  } else if (userAgent.includes("Linux")) {
    platform = "Linux";
  }

  return { browser, platform };
}

export default function SessionsSettingsContent() {
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeSuccess, setRevokeSuccess] = useState<string | null>(null);

  const sessionsQuery = trpc.users["me.sessions"].useQuery();
  const utils = trpc.useUtils();

  const revokeSessionMutation = trpc.users["me.revokeSession"].useMutation({
    onSuccess: () => {
      setRevokeSuccess("Session revoked successfully");
      setRevokeError(null);
      utils.users["me.sessions"].invalidate();
    },
    onError: (error) => {
      setRevokeError(error.message || "Failed to revoke session");
      setRevokeSuccess(null);
      toast.error("Failed to revoke session");
    },
  });

  const handleRevokeSession = (sessionId: string) => {
    setRevokeError(null);
    setRevokeSuccess(null);
    revokeSessionMutation.mutate({ sessionId });
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="ui-text-lg text-strong font-semibold">Active Sessions</h2>
        <span className="ui-text-sm text-subtle">
          {sessionsQuery.data?.sessions.length ?? 0} active
        </span>
      </div>

      <p className="ui-text-sm text-muted mb-6">
        These are the devices that are currently logged into your account. You can revoke any
        session that you do not recognize.
      </p>

      {revokeSuccess && (
        <Alert variant="success" className="mb-4">
          {revokeSuccess}
        </Alert>
      )}

      {revokeError && (
        <Alert variant="error" className="mb-4">
          {revokeError}
        </Alert>
      )}

      <SettingsListContainer
        items={sessionsQuery.data?.sessions}
        isLoading={sessionsQuery.isLoading}
        error={sessionsQuery.error}
        errorMessage="Failed to load sessions. Please try again."
        variant="card"
        emptyMessage="No active sessions"
        renderItem={(session) => (
          <SessionCard
            key={session.id}
            session={session}
            onRevoke={handleRevokeSession}
            isRevoking={revokeSessionMutation.isPending}
          />
        )}
      />
    </div>
  );
}

// ============================================================================
// Session Card
// ============================================================================

interface SessionCardProps {
  session: {
    id: string;
    userAgent: string | null;
    ipAddress: string | null;
    isCurrent: boolean;
    lastActiveAt: Date;
    createdAt: Date;
  };
  onRevoke: (sessionId: string) => void;
  isRevoking: boolean;
}

function SessionCard({ session, onRevoke, isRevoking }: SessionCardProps) {
  const { browser, platform } = parseUserAgent(session.userAgent);
  const lastActive = new Date(session.lastActiveAt);

  return (
    <div
      className={`rounded-lg border p-3 sm:p-4 ${
        session.isCurrent
          ? "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950"
          : "border-edge bg-surface"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            {/* Device icon */}
            <div className="bg-surface-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
              {platform === "iOS" || platform === "Android" ? (
                <MobileIcon className="text-muted h-4 w-4" />
              ) : (
                <DesktopIcon className="text-muted h-4 w-4" />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-strong font-medium">
                {browser} on {platform}
              </p>
              {session.isCurrent && (
                <span className="ui-text-xs mt-0.5 inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-800 dark:bg-green-900 dark:text-green-200">
                  Current session
                </span>
              )}
              <p className="ui-text-sm text-subtle">{session.ipAddress || "Unknown IP"}</p>
            </div>
          </div>

          <div className="ui-text-xs text-subtle mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <span>Last active: {formatRelativeTime(lastActive)}</span>
            <span>
              Created:{" "}
              {new Date(session.createdAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </div>
        </div>

        {!session.isCurrent && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRevoke(session.id)}
            disabled={isRevoking}
            className="w-full text-red-600 hover:bg-red-50 hover:text-red-700 sm:w-auto dark:text-red-400 dark:hover:bg-red-950 dark:hover:text-red-300"
          >
            Revoke
          </Button>
        )}
      </div>
    </div>
  );
}
