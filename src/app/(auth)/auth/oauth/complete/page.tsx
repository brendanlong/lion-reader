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
import { SpinnerIcon } from "@/components/ui/icon-button";
import { safeRedirectPath } from "@/lib/safe-redirect";

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

    // Sanitize to a same-origin path to prevent an open redirect (this value is
    // also broadcast to other tabs, so an off-site URL must never pass through).
    const redirectTo = safeRedirectPath(searchParams.get("redirect"));

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
      <h2 className="ui-text-xl text-body mb-6 font-semibold">Sign-in successful</h2>
      <div className="flex flex-col items-center gap-4">
        <SpinnerIcon className="text-body h-8 w-8" />
        <p className="ui-text-sm text-muted">Redirecting...</p>
      </div>
    </div>
  );
}
