/**
 * OAuth Complete Page
 *
 * This page serves as an intermediate step after OAuth authentication completes.
 * Its purpose is to broadcast the OAuth completion event so that PWAs running
 * in a separate context (common on Firefox Android) can detect that auth finished.
 *
 * Flow:
 * 1. OAuth callback sets the session cookie
 * 2. Callback redirects here with ?redirect=<target>
 * 3. This page broadcasts completion via BroadcastChannel and localStorage
 * 4. Then redirects to the target page
 *
 * For PWAs: The original PWA window listens for the broadcast and refreshes
 * to pick up the session cookie, even if OAuth happened in a separate browser window.
 */

"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { broadcastOAuthComplete } from "@/lib/oauth-channel";

export default function OAuthCompletePage() {
  return (
    <Suspense>
      <OAuthCompleteContent />
    </Suspense>
  );
}

function OAuthCompleteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hasProcessed = useRef(false);

  useEffect(() => {
    if (hasProcessed.current) return;
    hasProcessed.current = true;

    const redirectTo = searchParams.get("redirect") ?? "/all";

    // Broadcast OAuth completion for PWAs listening in other windows/tabs
    broadcastOAuthComplete(redirectTo);

    // Small delay to ensure broadcast is sent before redirecting
    // This helps ensure the message is received by listeners
    setTimeout(() => {
      router.replace(redirectTo);
    }, 100);
  }, [router, searchParams]);

  return (
    <div className="flex flex-col items-center justify-center">
      <h2 className="mb-6 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Sign-in successful
      </h2>
      <div className="flex flex-col items-center gap-4">
        <svg
          className="h-8 w-8 animate-spin text-zinc-900 dark:text-zinc-100"
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
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Redirecting...</p>
      </div>
    </div>
  );
}
