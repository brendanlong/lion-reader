/**
 * Google Sign-In Button Component
 *
 * Provides OAuth sign-in with Google. Uses the auth.providers query to check
 * if Google OAuth is enabled, and auth.googleAuthUrl to get the authorization URL.
 */

"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";

interface GoogleSignInButtonProps {
  /** Text to display on the button */
  label?: string;
  /** Called when an error occurs */
  onError?: (error: string) => void;
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
}: GoogleSignInButtonProps) {
  const [isLoading, setIsLoading] = useState(false);

  // Check if Google OAuth is enabled
  const { data: providersData, isLoading: isProvidersLoading } = trpc.auth.providers.useQuery();

  // Get the Google auth URL when the button is clicked
  const googleAuthUrlQuery = trpc.auth.googleAuthUrl.useQuery(undefined, {
    enabled: false, // Only fetch when manually triggered
  });

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
      className="flex min-h-[44px] w-full items-center justify-center gap-3 rounded-md border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-50 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:ring-zinc-400"
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
        <GoogleIcon />
      )}
      {label}
    </button>
  );
}

/**
 * Google "G" logo icon
 */
function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
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
