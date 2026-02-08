/**
 * Apple Sign-In Button Component
 *
 * Provides OAuth sign-in with Apple. Uses the auth.providers query to check
 * if Apple OAuth is enabled, and auth.appleAuthUrl to get the authorization URL.
 *
 * Apple has specific branding requirements for their sign-in button:
 * - Black or white button (we use black)
 * - Apple logo must be included
 * - Specific text formats: "Sign in with Apple" or "Continue with Apple"
 *
 * See: https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple
 */

"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { AppleIcon, SpinnerIcon } from "@/components/ui/icon-button";

interface AppleSignInButtonProps {
  /** Text to display on the button */
  label?: string;
  /** Called when an error occurs */
  onError?: (error: string) => void;
  /** Optional invite token for new user registration */
  inviteToken?: string;
}

/**
 * Apple OAuth sign-in button.
 *
 * Only renders if Apple OAuth is enabled on the server.
 * Handles the OAuth redirect flow.
 *
 * Note: Apple uses form_post response mode, so the callback is handled
 * by a dedicated API route that receives the POST and redirects.
 */
export function AppleSignInButton({
  label = "Sign in with Apple",
  onError,
  inviteToken,
}: AppleSignInButtonProps) {
  const [isLoading, setIsLoading] = useState(false);

  // Check if Apple OAuth is enabled
  const { data: providersData, isLoading: isProvidersLoading } = trpc.auth.providers.useQuery();

  // Get the Apple auth URL when the button is clicked
  const appleAuthUrlQuery = trpc.auth.appleAuthUrl.useQuery(
    { inviteToken },
    {
      enabled: false, // Only fetch when manually triggered
    }
  );

  const isAppleEnabled = providersData?.providers.includes("apple") ?? false;

  const handleClick = async () => {
    if (isLoading) return;

    setIsLoading(true);
    try {
      const result = await appleAuthUrlQuery.refetch();

      if (result.error) {
        const errorMessage = result.error.message || "Failed to start Apple sign-in";
        onError?.(errorMessage);
        setIsLoading(false);
        return;
      }

      if (result.data) {
        // Store state in localStorage for verification on callback
        // Note: For Apple form_post, the callback is handled server-side,
        // but we still store state for consistency and potential debugging
        localStorage.setItem("oauth_state", result.data.state);

        // Redirect to Apple OAuth
        window.location.href = result.data.url;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to start Apple sign-in";
      onError?.(errorMessage);
      setIsLoading(false);
    }
  };

  // Don't render if loading providers or if Apple is not enabled
  if (isProvidersLoading || !isAppleEnabled) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isLoading}
      className="ui-text-sm flex min-h-[44px] w-full items-center justify-center gap-3 rounded-md bg-black px-4 font-medium text-white transition-colors hover:bg-zinc-800 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200 dark:focus:ring-zinc-400"
    >
      {isLoading ? <SpinnerIcon className="h-5 w-5" /> : <AppleIcon className="h-5 w-5" />}
      {label}
    </button>
  );
}
