/**
 * API Tokens Settings Page
 *
 * Allows users to create and manage API tokens for MCP, browser extensions, etc.
 * Tokens are shown only once on creation - users must copy them immediately.
 */

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button, Input, Alert } from "@/components/ui";
import { SettingsListSkeleton } from "@/components/settings";
import { formatRelativeTime } from "@/lib/format";

/**
 * Get scope labels for display
 */
const scopeLabels: Record<string, { label: string; description: string }> = {
  "saved:write": {
    label: "Save Articles",
    description: "Create and manage saved articles",
  },
  mcp: {
    label: "MCP Access",
    description: "Full access via Model Context Protocol (Claude Desktop, etc.)",
  },
};

export default function ApiTokensSettingsContent() {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(["mcp"]);
  const [expiresInDays, setExpiresInDays] = useState<string>("");
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<string | null>(null);

  const tokensQuery = trpc.apiTokens.list.useQuery();
  const utils = trpc.useUtils();

  const createTokenMutation = trpc.apiTokens.create.useMutation({
    onSuccess: (data) => {
      setNewlyCreatedToken(data.token);
      setTokenName("");
      setSelectedScopes(["mcp"]);
      setExpiresInDays("");
      setShowCreateForm(false);
      utils.apiTokens.list.invalidate();
      toast.success("API token created");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create token");
    },
  });

  const revokeTokenMutation = trpc.apiTokens.revoke.useMutation({
    onSuccess: () => {
      utils.apiTokens.list.invalidate();
      toast.success("Token revoked");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to revoke token");
    },
  });

  const handleCreateToken = () => {
    if (!tokenName.trim()) {
      toast.error("Please enter a token name");
      return;
    }
    if (selectedScopes.length === 0) {
      toast.error("Please select at least one scope");
      return;
    }

    const expiresInDaysNum = expiresInDays ? parseInt(expiresInDays, 10) : undefined;
    if (expiresInDays && (isNaN(expiresInDaysNum!) || expiresInDaysNum! <= 0)) {
      toast.error("Please enter a valid number of days");
      return;
    }

    createTokenMutation.mutate({
      name: tokenName,
      scopes: selectedScopes as ("saved:write" | "mcp")[],
      expiresInDays: expiresInDaysNum,
    });
  };

  const handleCopyToken = () => {
    if (newlyCreatedToken) {
      navigator.clipboard.writeText(newlyCreatedToken);
      toast.success("Token copied to clipboard");
    }
  };

  const handleRevokeToken = (tokenId: string) => {
    if (confirm("Are you sure you want to revoke this token? This action cannot be undone.")) {
      revokeTokenMutation.mutate({ tokenId });
    }
  };

  const toggleScope = (scope: string) => {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  };

  // Get active (non-revoked, non-expired) tokens
  const activeTokens =
    tokensQuery.data?.filter(
      (token) => !token.revokedAt && (!token.expiresAt || new Date(token.expiresAt) > new Date())
    ) ?? [];

  // Get revoked or expired tokens
  const inactiveTokens =
    tokensQuery.data?.filter(
      (token) => token.revokedAt || (token.expiresAt && new Date(token.expiresAt) <= new Date())
    ) ?? [];

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">API Tokens</h2>
        {!showCreateForm && (
          <Button onClick={() => setShowCreateForm(true)} size="sm">
            Create New Token
          </Button>
        )}
      </div>

      <p className="ui-text-sm mb-6 text-zinc-600 dark:text-zinc-400">
        API tokens allow you to connect third-party applications like Claude Desktop, browser
        extensions, and other integrations. Tokens are only shown once when created.
      </p>

      {/* Newly Created Token Alert */}
      {newlyCreatedToken && (
        <Alert variant="success" className="mb-6">
          <div className="space-y-3">
            <p className="font-medium">Token created successfully!</p>
            <p className="ui-text-sm">
              Copy this token now - you won&apos;t be able to see it again.
            </p>
            <div className="flex gap-2">
              <Input
                value={newlyCreatedToken}
                readOnly
                className="ui-text-sm flex-1 font-mono"
                onClick={(e) => e.currentTarget.select()}
              />
              <Button onClick={handleCopyToken} size="sm">
                Copy
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setNewlyCreatedToken(null)}
              className="ui-text-xs"
            >
              I&apos;ve saved my token
            </Button>
          </div>
        </Alert>
      )}

      {/* Create Token Form */}
      {showCreateForm && (
        <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="mb-4 font-medium text-zinc-900 dark:text-zinc-50">Create New Token</h3>

          <div className="space-y-4">
            {/* Token Name */}
            <div>
              <label className="ui-text-sm mb-1 block font-medium text-zinc-700 dark:text-zinc-300">
                Token Name
              </label>
              <Input
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                placeholder="e.g., Claude Desktop, Browser Extension"
                className="w-full"
              />
              <p className="ui-text-xs mt-1 text-zinc-500 dark:text-zinc-400">
                A descriptive name to help you identify this token
              </p>
            </div>

            {/* Scopes */}
            <div>
              <label className="ui-text-sm mb-2 block font-medium text-zinc-700 dark:text-zinc-300">
                Scopes
              </label>
              <div className="space-y-2">
                {Object.entries(scopeLabels).map(([scope, { label, description }]) => (
                  <label
                    key={scope}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 p-3 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800"
                  >
                    <input
                      type="checkbox"
                      checked={selectedScopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                      className="mt-1 h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-800"
                    />
                    <div className="flex-1">
                      <p className="font-medium text-zinc-900 dark:text-zinc-50">{label}</p>
                      <p className="ui-text-xs text-zinc-500 dark:text-zinc-400">{description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Expiration (Optional) */}
            <div>
              <label className="ui-text-sm mb-1 block font-medium text-zinc-700 dark:text-zinc-300">
                Expiration (Optional)
              </label>
              <Input
                type="number"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder="Days until expiration (leave empty for no expiration)"
                className="w-full"
                min="1"
              />
              <p className="ui-text-xs mt-1 text-zinc-500 dark:text-zinc-400">
                Leave empty for a token that never expires
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                onClick={handleCreateToken}
                disabled={createTokenMutation.isPending}
                className="flex-1"
              >
                {createTokenMutation.isPending ? "Creating..." : "Create Token"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setShowCreateForm(false);
                  setTokenName("");
                  setSelectedScopes(["mcp"]);
                  setExpiresInDays("");
                }}
                disabled={createTokenMutation.isPending}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Active Tokens List */}
      <div className="mb-6">
        <h3 className="ui-text-sm mb-3 font-medium text-zinc-700 dark:text-zinc-300">
          Active Tokens ({activeTokens.length})
        </h3>
        <div className="space-y-3">
          {tokensQuery.isLoading ? (
            <SettingsListSkeleton count={2} variant="card" />
          ) : tokensQuery.error ? (
            <Alert variant="error">Failed to load tokens. Please try again.</Alert>
          ) : activeTokens.length === 0 ? (
            <p className="ui-text-sm text-center text-zinc-500 dark:text-zinc-400">
              No active tokens. Create one to get started.
            </p>
          ) : (
            activeTokens.map((token) => (
              <div
                key={token.id}
                className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      {/* Key icon */}
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
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
                            d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                          />
                        </svg>
                      </div>

                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-zinc-900 dark:text-zinc-50">
                          {token.name || "Unnamed Token"}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {token.scopes.map((scope) => (
                            <span
                              key={scope}
                              className="ui-text-xs inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 font-medium text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                            >
                              {scopeLabels[scope]?.label ?? scope}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="ui-text-xs mt-2 flex flex-wrap gap-x-4 gap-y-1 text-zinc-500 dark:text-zinc-400">
                      <span>
                        Created:{" "}
                        {new Date(token.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </span>
                      {token.lastUsedAt && (
                        <span>Last used: {formatRelativeTime(new Date(token.lastUsedAt))}</span>
                      )}
                      {token.expiresAt && (
                        <span>
                          Expires:{" "}
                          {new Date(token.expiresAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </span>
                      )}
                      {!token.lastUsedAt && (
                        <span className="text-amber-600 dark:text-amber-400">Never used</span>
                      )}
                    </div>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRevokeToken(token.id)}
                    disabled={revokeTokenMutation.isPending}
                    className="w-full text-red-600 hover:bg-red-50 hover:text-red-700 sm:w-auto dark:text-red-400 dark:hover:bg-red-950 dark:hover:text-red-300"
                  >
                    Revoke
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Revoked/Expired Tokens */}
      {inactiveTokens.length > 0 && (
        <div>
          <h3 className="ui-text-sm mb-3 font-medium text-zinc-700 dark:text-zinc-300">
            Revoked/Expired Tokens ({inactiveTokens.length})
          </h3>
          <div className="space-y-3">
            {inactiveTokens.map((token) => (
              <div
                key={token.id}
                className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 opacity-60 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <svg
                      className="h-4 w-4 text-zinc-400 dark:text-zinc-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </div>
                  <div>
                    <p className="font-medium text-zinc-700 dark:text-zinc-400">
                      {token.name || "Unnamed Token"}
                    </p>
                    <p className="ui-text-xs text-zinc-500 dark:text-zinc-500">
                      {token.revokedAt
                        ? `Revoked ${formatRelativeTime(new Date(token.revokedAt))}`
                        : `Expired ${formatRelativeTime(new Date(token.expiresAt!))}`}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
