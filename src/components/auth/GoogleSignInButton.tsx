/**
 * Google Sign-In Button Component
 *
 * Provides OAuth sign-in with Google. Uses the auth.providers query to check
 * if Google OAuth is enabled, and auth.googleAuthUrl to get the authorization URL.
 */

"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { GoogleIcon, SpinnerIcon } from "@/components/ui/icon-button";

interface GoogleSignInButtonProps {
  /** Text to display on the button */
  label?: string;
  /** Called when an error occurs */
  onError?: (error: string) => void;
  /** Optional invite token for new user registration */
  inviteToken?: string;
}

/**
 * Google OAuth sign-in button.
 *
 * Only renders if Google OAuth is enabled on the server.
 * Handles the OAuth redirect flow.
 */
export function GoogleSignInButton({
  label = "Sign in with Google",
  onError,
  inviteToken,
}: GoogleSignInButtonProps) {
  const [isLoading, setIsLoading] = useState(false);

  // Check if Google OAuth is enabled
  const { data: providersData, isLoading: isProvidersLoading } = trpc.auth.providers.useQuery();

  // Get the Google auth URL when the button is clicked
  const googleAuthUrlQuery = trpc.auth.googleAuthUrl.useQuery(
    { inviteToken },
    {
      enabled: false, // Only fetch when manually triggered
    }
  );

  const isGoogleEnabled = providersData?.providers.includes("google") ?? false;

  const handleClick = async () => {
    if (isLoading) return;

    setIsLoading(true);
    try {
      const result = await googleAuthUrlQuery.refetch();

      if (result.error) {
        const errorMessage = result.error.message || "Failed to start Google sign-in";
        onError?.(errorMessage);
        setIsLoading(false);
        return;
      }

      if (result.data) {
        // Store state in localStorage for verification on callback
        localStorage.setItem("oauth_state", result.data.state);

        // Redirect to Google OAuth
        window.location.href = result.data.url;
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to start Google sign-in";
      onError?.(errorMessage);
      setIsLoading(false);
    }
  };

  // Don't render if loading providers or if Google is not enabled
  if (isProvidersLoading || !isGoogleEnabled) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isLoading}
      className="ui-text-sm flex min-h-[44px] w-full items-center justify-center gap-3 rounded-md border border-zinc-300 bg-white px-4 font-medium text-zinc-900 transition-colors hover:bg-zinc-50 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:ring-zinc-400"
    >
      {isLoading ? <SpinnerIcon className="h-5 w-5" /> : <GoogleIcon className="h-5 w-5" />}
      {label}
    </button>
  );
}
