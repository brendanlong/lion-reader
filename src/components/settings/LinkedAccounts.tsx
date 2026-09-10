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
import { useFormMessages } from "@/lib/hooks/useFormMessages";
import { Button } from "@/components/ui/button";
import { NoteBox } from "@/components/ui/note-box";
import { type OAuthProvider, providerNames, ProviderIcon } from "@/components/auth/oauth-helpers";
import { SettingsSection } from "./SettingsSection";

// ============================================================================
// Types
// ============================================================================

interface LinkedAccount {
  provider: OAuthProvider;
  linkedAt: Date;
}

// ============================================================================
// LinkedAccounts Component
// ============================================================================

export function LinkedAccounts() {
  const { error, success, showError, showSuccess, clearMessages } = useFormMessages();
  const [linkingProvider, setLinkingProvider] = useState<OAuthProvider | null>(null);
  const [unlinkingProvider, setUnlinkingProvider] = useState<OAuthProvider | null>(null);

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

  // Starts a link flow: the callback attaches the provider account to the user
  // who started it, whatever email the provider reports (#1603).
  const linkAuthUrlMutation = trpc.auth.linkAuthUrl.useMutation();

  // Unlink mutation
  const unlinkMutation = trpc.auth.unlinkProvider.useMutation({
    onSuccess: (_, variables) => {
      const name = providerNames[variables.provider as OAuthProvider];
      showSuccess(`${name} account unlinked successfully`);
      setUnlinkingProvider(null);
      utils.users["me.linkedAccounts"].invalidate();
    },
    onError: (err) => {
      // `SESSION_REVOKE_FAILED` means the unlink landed and only signing the
      // user's other devices out failed, so don't claim it failed — the error
      // message says what to do next. Either way the list may have changed.
      const unlinked = err.data?.appErrorCode === "SESSION_REVOKE_FAILED";
      showError(err.message || "Failed to unlink account");
      setUnlinkingProvider(null);
      toast.error(unlinked ? err.message : "Failed to unlink account");
      utils.users["me.linkedAccounts"].invalidate();
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
    async (provider: OAuthProvider) => {
      setLinkingProvider(provider);
      clearMessages();

      try {
        const { url } = await linkAuthUrlMutation.mutateAsync({ provider });
        // Leaving the app for the provider: a full navigation, not a soft one.
        window.location.href = url;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : `Failed to start ${provider} linking`;
        showError(errorMessage);
        setLinkingProvider(null);
      }
    },
    [linkAuthUrlMutation, clearMessages, showError]
  );

  const handleUnlinkProvider = useCallback(
    (provider: OAuthProvider) => {
      if (!canUnlink) {
        showError(
          "Cannot unlink this account because it is your only authentication method. Add a password first."
        );
        return;
      }

      setUnlinkingProvider(provider);
      clearMessages();

      unlinkMutation.mutate({ provider });
    },
    [canUnlink, unlinkMutation, clearMessages, showError]
  );

  if (queryError) {
    return (
      <SettingsSection title="Linked Accounts" error="Failed to load linked accounts">
        <div />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="Linked Accounts"
      description="Connect your account with third-party providers for easy sign-in."
      isLoading={isLoading}
      error={error}
      success={success}
    >
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
          <p className="ui-text-sm text-muted">No OAuth providers are configured on this server.</p>
        )}
      </div>

      {!hasPassword && linkedAccounts.length > 0 && (
        <p className="ui-text-xs text-muted mt-4">
          Tip: Add a password to your account so you can unlink OAuth providers if needed.
        </p>
      )}
    </SettingsSection>
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
  const name = providerNames[account.provider];
  const linkedDate = new Date(account.linkedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <NoteBox className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <ProviderIcon provider={account.provider} />
        <div>
          <p className="ui-text-sm text-body font-medium">{name}</p>
          <p className="ui-text-xs text-muted">Linked on {linkedDate}</p>
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={onUnlink}
        loading={isUnlinking}
        disabled={!canUnlink || isUnlinking}
        title={canUnlink ? `Unlink ${name}` : "Cannot unlink only authentication method"}
      >
        Unlink
      </Button>
    </NoteBox>
  );
}

// ============================================================================
// Linkable Provider Item Component
// ============================================================================

interface LinkableProviderItemProps {
  provider: OAuthProvider;
  isLinking: boolean;
  onLink: () => void;
}

function LinkableProviderItem({ provider, isLinking, onLink }: LinkableProviderItemProps) {
  const name = providerNames[provider];

  return (
    <div className="border-edge-input flex items-center justify-between rounded-md border border-dashed p-4">
      <div className="flex items-center gap-3">
        <ProviderIcon provider={provider} muted />
        <div>
          <p className="ui-text-sm text-muted font-medium">{name}</p>
          <p className="ui-text-xs text-muted">Not connected</p>
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={onLink}
        loading={isLinking}
        disabled={isLinking}
        title={`Link ${name}`}
      >
        Link
      </Button>
    </div>
  );
}
