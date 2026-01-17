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
import { Button, Alert } from "@/components/ui";

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

function GoogleIcon({ muted = false }: { muted?: boolean }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={muted ? "opacity-40" : ""}
    >
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function AppleIcon({ muted = false }: { muted?: boolean }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={muted ? "opacity-40" : ""}
    >
      <path
        d="M17.569 12.6254C17.597 15.6529 20.2179 16.6664 20.25 16.6804C20.2269 16.7524 19.8318 18.1419 18.8424 19.5749C17.9814 20.8234 17.0879 22.0654 15.6889 22.0924C14.3144 22.1189 13.8759 21.2894 12.3019 21.2894C10.7284 21.2894 10.2394 22.0654 8.93942 22.1189C7.58992 22.1724 6.55792 20.7694 5.68992 19.5274C3.91792 17.0004 2.55692 12.3654 4.37192 9.26839C5.27192 7.73289 6.87892 6.76039 8.61792 6.73389C9.94292 6.70739 11.1934 7.61239 12.0089 7.61239C12.8239 7.61239 14.3369 6.52239 15.9404 6.68489C16.6284 6.71439 18.4849 6.95989 19.6939 8.68489C19.5999 8.74239 17.5469 9.94739 17.569 12.6254ZM14.9069 4.63539C15.6219 3.77889 16.1079 2.58939 15.9729 1.40039C14.9484 1.44239 13.7029 2.09039 12.9634 2.94639C12.3014 3.70689 11.7134 4.92339 11.8724 6.08439C13.0109 6.17239 14.1919 5.49239 14.9069 4.63539Z"
        fill="currentColor"
        className="text-zinc-900 dark:text-zinc-100"
      />
    </svg>
  );
}
