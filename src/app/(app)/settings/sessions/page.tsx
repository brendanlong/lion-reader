/**
 * Sessions Page
 *
 * Displays all active sessions for the current user.
 * Allows revoking sessions except the current one.
 */

"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { Button, Alert } from "@/components/ui";

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

/**
 * Format relative time ago
 */
function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) {
    return "Just now";
  } else if (diffMins < 60) {
    return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  } else if (diffDays < 7) {
    return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  } else {
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: diffDays > 365 ? "numeric" : undefined,
    });
  }
}

export default function SessionsPage() {
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
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Active Sessions</h2>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          {sessionsQuery.data?.sessions.length ?? 0} active
        </span>
      </div>

      <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
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

      <div className="space-y-3">
        {sessionsQuery.isLoading ? (
          <>
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-24 animate-pulse rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
              />
            ))}
          </>
        ) : sessionsQuery.error ? (
          <Alert variant="error">Failed to load sessions. Please try again.</Alert>
        ) : sessionsQuery.data?.sessions.length === 0 ? (
          <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">No active sessions</p>
        ) : (
          sessionsQuery.data?.sessions.map((session) => {
            const { browser, platform } = parseUserAgent(session.userAgent);
            const lastActive = new Date(session.lastActiveAt);

            return (
              <div
                key={session.id}
                className={`rounded-lg border p-3 sm:p-4 ${
                  session.isCurrent
                    ? "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950"
                    : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      {/* Device icon */}
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
                        {platform === "iOS" || platform === "Android" ? (
                          <svg
                            className="h-4 w-4 text-zinc-600 dark:text-zinc-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                            />
                          </svg>
                        ) : (
                          <svg
                            className="h-4 w-4 text-zinc-600 dark:text-zinc-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                            />
                          </svg>
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-zinc-900 dark:text-zinc-50">
                          {browser} on {platform}
                        </p>
                        {session.isCurrent && (
                          <span className="mt-0.5 inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900 dark:text-green-200">
                            Current session
                          </span>
                        )}
                        <p className="text-sm text-zinc-500 dark:text-zinc-400">
                          {session.ipAddress || "Unknown IP"}
                        </p>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                      <span>Last active: {formatTimeAgo(lastActive)}</span>
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
                      onClick={() => handleRevokeSession(session.id)}
                      disabled={revokeSessionMutation.isPending}
                      className="w-full text-red-600 hover:bg-red-50 hover:text-red-700 sm:w-auto dark:text-red-400 dark:hover:bg-red-950 dark:hover:text-red-300"
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
