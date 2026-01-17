/**
 * Discord Sign-In Button Component
 *
 * Provides OAuth sign-in with Discord. Uses the auth.providers query to check
 * if Discord OAuth is enabled, and auth.discordAuthUrl to get the authorization URL.
 */

"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { DiscordIcon, SpinnerIcon } from "@/components/ui";

interface DiscordSignInButtonProps {
  /** Text to display on the button */
  label?: string;
  /** Called when an error occurs */
  onError?: (error: string) => void;
  /** Optional invite token for new user registration */
  inviteToken?: string;
}

/**
 * Discord OAuth sign-in button.
 *
 * Only renders if Discord OAuth is enabled on the server.
 * Handles the OAuth redirect flow.
 */
export function DiscordSignInButton({
  label = "Sign in with Discord",
  onError,
  inviteToken,
}: DiscordSignInButtonProps) {
  const [isLoading, setIsLoading] = useState(false);

  // Check if Discord OAuth is enabled
  const { data: providersData, isLoading: isProvidersLoading } = trpc.auth.providers.useQuery();

  // Get the Discord auth URL when the button is clicked
  const discordAuthUrlQuery = trpc.auth.discordAuthUrl.useQuery(
    { inviteToken },
    {
      enabled: false, // Only fetch when manually triggered
    }
  );

  const isDiscordEnabled = providersData?.providers.includes("discord") ?? false;

  const handleClick = async () => {
    if (isLoading) return;

    setIsLoading(true);
    try {
      const result = await discordAuthUrlQuery.refetch();

      if (result.error) {
        const errorMessage = result.error.message || "Failed to start Discord sign-in";
        onError?.(errorMessage);
        setIsLoading(false);
        return;
      }

      if (result.data) {
        // Store state in localStorage for verification on callback
        localStorage.setItem("oauth_state", result.data.state);

        // Redirect to Discord OAuth
        window.location.href = result.data.url;
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to start Discord sign-in";
      onError?.(errorMessage);
      setIsLoading(false);
    }
  };

  // Don't render if loading providers or if Discord is not enabled
  if (isProvidersLoading || !isDiscordEnabled) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isLoading}
      className="ui-text-sm flex min-h-[44px] w-full items-center justify-center gap-3 rounded-md border border-zinc-300 bg-white px-4 font-medium text-zinc-900 transition-colors hover:bg-zinc-50 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:ring-zinc-400"
    >
      {isLoading ? <SpinnerIcon className="h-5 w-5" /> : <DiscordIcon className="h-5 w-5" />}
      {label}
    </button>
  );
}
