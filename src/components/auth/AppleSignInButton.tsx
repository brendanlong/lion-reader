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
      className="flex min-h-[44px] w-full items-center justify-center gap-3 rounded-md bg-black px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200 dark:focus:ring-zinc-400"
    >
      {isLoading ? (
        <svg
          className="h-5 w-5 animate-spin"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      ) : (
        <AppleIcon />
      )}
      {label}
    </button>
  );
}

/**
 * Apple logo icon
 * Official Apple logo for Sign in with Apple button
 */
function AppleIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
    >
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}
