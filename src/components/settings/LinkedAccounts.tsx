/**
 * Linked Accounts Component
 *
 * Displays OAuth accounts linked to the user's account with options to
 * link new providers or unlink existing ones.
 *
 * Features:
 * - Shows which OAuth providers are linked
 * - Allows linking new providers via OAuth flow
 * - Allows unlinking providers (if not the only auth method)
 */

"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button, Alert, GoogleIcon, AppleIcon } from "@/components/ui";

// ============================================================================
// Types
// ============================================================================

type Provider = "google" | "apple";

interface LinkedAccount {
  provider: Provider;
  linkedAt: Date;
}

// ============================================================================
// LinkedAccounts Component
// ============================================================================

export function LinkedAccounts() {
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [linkingProvider, setLinkingProvider] = useState<Provider | null>(null);
  const [unlinkingProvider, setUnlinkingProvider] = useState<Provider | null>(null);

  const utils = trpc.useUtils();

  // Get enabled OAuth providers
  const { data: providersData } = trpc.auth.providers.useQuery();
  const enabledProviders = providersData?.providers ?? [];

  // Get linked accounts
  const {
    data: linkedAccountsData,
    isLoading,
    error: queryError,
  } = trpc.users["me.linkedAccounts"].useQuery();

  // Get Google auth URL for linking
  const googleAuthUrlQuery = trpc.auth.googleAuthUrl.useQuery(undefined, {
    enabled: false,
  });

  // Get Apple auth URL for linking
  const appleAuthUrlQuery = trpc.auth.appleAuthUrl.useQuery(undefined, {
    enabled: false,
  });

  // Unlink mutation
  const unlinkMutation = trpc.auth.unlinkProvider.useMutation({
    onSuccess: (_, variables) => {
      const providerName = variables.provider === "google" ? "Google" : "Apple";
      setSuccessMessage(`${providerName} account unlinked successfully`);
      setError(null);
      setUnlinkingProvider(null);
      utils.users["me.linkedAccounts"].invalidate();
      // Clear success message after 3 seconds
      setTimeout(() => setSuccessMessage(null), 3000);
    },
    onError: (err) => {
      setError(err.message || "Failed to unlink account");
      setSuccessMessage(null);
      setUnlinkingProvider(null);
      toast.error("Failed to unlink account");
    },
  });

  const linkedAccounts = linkedAccountsData?.accounts ?? [];
  const hasPassword = linkedAccountsData?.hasPassword ?? false;

  // Determine which providers can be linked (enabled and not already linked)
  const linkedProviders = new Set(linkedAccounts.map((a) => a.provider));
  const linkableProviders = enabledProviders.filter((p) => !linkedProviders.has(p));

  // Determine if unlinking is allowed (user must have password or multiple OAuth accounts)
  const canUnlink = hasPassword || linkedAccounts.length > 1;

  const handleLinkProvider = useCallback(
    async (provider: Provider) => {
      setLinkingProvider(provider);
      setError(null);
      setSuccessMessage(null);

      try {
        const query = provider === "google" ? googleAuthUrlQuery : appleAuthUrlQuery;
        const result = await query.refetch();

        if (result.error) {
          setError(result.error.message || `Failed to start ${provider} linking`);
          setLinkingProvider(null);
          return;
        }

        if (result.data) {
          // Store state for verification on callback
          localStorage.setItem("oauth_state", result.data.state);
          // Mark this as a link operation (not login)
          localStorage.setItem("oauth_link_mode", "true");
          localStorage.setItem("oauth_link_provider", provider);

          // Redirect to OAuth provider
          window.location.href = result.data.url;
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : `Failed to start ${provider} linking`;
        setError(errorMessage);
        setLinkingProvider(null);
      }
    },
    [googleAuthUrlQuery, appleAuthUrlQuery]
  );

  const handleUnlinkProvider = useCallback(
    (provider: Provider) => {
      if (!canUnlink) {
        setError(
          "Cannot unlink this account because it is your only authentication method. Add a password first."
        );
        return;
      }

      setUnlinkingProvider(provider);
      setError(null);
      setSuccessMessage(null);

      unlinkMutation.mutate({ provider });
    },
    [canUnlink, unlinkMutation]
  );

  if (isLoading) {
    return (
      <section>
        <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">
          Linked Accounts
        </h2>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="space-y-4">
            <div className="h-12 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-12 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          </div>
        </div>
      </section>
    );
  }

  if (queryError) {
    return (
      <section>
        <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">
          Linked Accounts
        </h2>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <Alert variant="error">Failed to load linked accounts</Alert>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">
        Linked Accounts
      </h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="ui-text-sm mb-4 text-zinc-500 dark:text-zinc-400">
          Connect your account with third-party providers for easy sign-in.
        </p>

        {error && (
          <Alert variant="error" className="mb-4">
            {error}
          </Alert>
        )}

        {successMessage && (
          <Alert variant="success" className="mb-4">
            {successMessage}
          </Alert>
        )}

        <div className="space-y-3">
          {/* Show linked accounts */}
          {linkedAccounts.map((account) => (
            <LinkedAccountItem
              key={account.provider}
              account={account}
              canUnlink={canUnlink}
              isUnlinking={unlinkingProvider === account.provider}
              onUnlink={() => handleUnlinkProvider(account.provider)}
            />
          ))}

          {/* Show linkable providers */}
          {linkableProviders.map((provider) => (
            <LinkableProviderItem
              key={provider}
              provider={provider}
              isLinking={linkingProvider === provider}
              onLink={() => handleLinkProvider(provider)}
            />
          ))}

          {/* Show message if no providers available */}
          {enabledProviders.length === 0 && linkedAccounts.length === 0 && (
            <p className="ui-text-sm text-zinc-500 dark:text-zinc-400">
              No OAuth providers are configured on this server.
            </p>
          )}
        </div>

        {!hasPassword && linkedAccounts.length > 0 && (
          <p className="ui-text-xs mt-4 text-zinc-500 dark:text-zinc-400">
            Tip: Add a password to your account so you can unlink OAuth providers if needed.
          </p>
        )}
      </div>
    </section>
  );
}

// ============================================================================
// Linked Account Item Component
// ============================================================================

interface LinkedAccountItemProps {
  account: LinkedAccount;
  canUnlink: boolean;
  isUnlinking: boolean;
  onUnlink: () => void;
}

function LinkedAccountItem({ account, canUnlink, isUnlinking, onUnlink }: LinkedAccountItemProps) {
  const providerName = account.provider === "google" ? "Google" : "Apple";
  const linkedDate = new Date(account.linkedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/50">
      <div className="flex items-center gap-3">
        <ProviderIcon provider={account.provider} />
        <div>
          <p className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">{providerName}</p>
          <p className="ui-text-xs text-zinc-500 dark:text-zinc-400">Linked on {linkedDate}</p>
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={onUnlink}
        loading={isUnlinking}
        disabled={!canUnlink || isUnlinking}
        title={canUnlink ? `Unlink ${providerName}` : "Cannot unlink only authentication method"}
      >
        Unlink
      </Button>
    </div>
  );
}

// ============================================================================
// Linkable Provider Item Component
// ============================================================================

interface LinkableProviderItemProps {
  provider: Provider;
  isLinking: boolean;
  onLink: () => void;
}

function LinkableProviderItem({ provider, isLinking, onLink }: LinkableProviderItemProps) {
  const providerName = provider === "google" ? "Google" : "Apple";

  return (
    <div className="flex items-center justify-between rounded-md border border-dashed border-zinc-300 p-4 dark:border-zinc-600">
      <div className="flex items-center gap-3">
        <ProviderIcon provider={provider} muted />
        <div>
          <p className="ui-text-sm font-medium text-zinc-600 dark:text-zinc-400">{providerName}</p>
          <p className="ui-text-xs text-zinc-500 dark:text-zinc-500">Not connected</p>
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={onLink}
        loading={isLinking}
        disabled={isLinking}
      >
        Link
      </Button>
    </div>
  );
}

// ============================================================================
// Provider Icon Component
// ============================================================================

interface ProviderIconProps {
  provider: Provider;
  muted?: boolean;
}

function ProviderIcon({ provider, muted = false }: ProviderIconProps) {
  if (provider === "google") {
    return <GoogleIcon muted={muted} />;
  }
  return <AppleIcon muted={muted} />;
}
