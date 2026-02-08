/**
 * Generic OAuth Sign-In Button Component
 *
 * Provides OAuth sign-in for any supported provider. Uses the auth.providers
 * query to check if the provider is enabled, and the provider-specific auth
 * URL endpoint to get the authorization URL.
 *
 * Apple has specific branding requirements (black button style).
 * See: https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple
 */

"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { SpinnerIcon } from "@/components/ui/icon-button";
import { type OAuthProvider, providerNames, ProviderIcon, useAuthUrlQuery } from "./oauth-helpers";

interface OAuthSignInButtonProps {
  provider: OAuthProvider;
  label?: string;
  onError?: (error: string) => void;
  inviteToken?: string;
}

const defaultButtonClassName =
  "ui-text-sm flex min-h-[44px] w-full items-center justify-center gap-3 rounded-md border border-zinc-300 bg-white px-4 font-medium text-zinc-900 transition-colors hover:bg-zinc-50 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:ring-zinc-400";

const appleButtonClassName =
  "ui-text-sm flex min-h-[44px] w-full items-center justify-center gap-3 rounded-md bg-black px-4 font-medium text-white transition-colors hover:bg-zinc-800 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200 dark:focus:ring-zinc-400";

export function OAuthSignInButton({
  provider,
  label,
  onError,
  inviteToken,
}: OAuthSignInButtonProps) {
  const [isLoading, setIsLoading] = useState(false);

  const { data: providersData, isLoading: isProvidersLoading } = trpc.auth.providers.useQuery();

  const authUrlQuery = useAuthUrlQuery(provider, inviteToken);

  const isEnabled = providersData?.providers.includes(provider) ?? false;

  const resolvedLabel = label ?? `Sign in with ${providerNames[provider]}`;

  const handleClick = async () => {
    if (isLoading) return;

    setIsLoading(true);
    try {
      const result = await authUrlQuery.refetch();

      if (result.error) {
        const errorMessage =
          result.error.message || `Failed to start ${providerNames[provider]} sign-in`;
        onError?.(errorMessage);
        setIsLoading(false);
        return;
      }

      if (result.data) {
        localStorage.setItem("oauth_state", result.data.state);
        window.location.href = result.data.url;
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : `Failed to start ${providerNames[provider]} sign-in`;
      onError?.(errorMessage);
      setIsLoading(false);
    }
  };

  if (isProvidersLoading || !isEnabled) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isLoading}
      className={provider === "apple" ? appleButtonClassName : defaultButtonClassName}
    >
      {isLoading ? (
        <SpinnerIcon className="h-5 w-5" />
      ) : (
        <ProviderIcon provider={provider} className="h-5 w-5" />
      )}
      {resolvedLabel}
    </button>
  );
}
