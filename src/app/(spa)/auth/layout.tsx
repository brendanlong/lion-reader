/**
 * OAuth Transition Layout
 *
 * Server component wrapper for the OAuth callback/complete pages
 * (/auth/oauth/*). Redirects already-authenticated users to /all, matching the
 * shared auth layout these pages previously lived under. The login/register
 * pages moved to the statically-prerendered `(public)` group (issue #1359) and
 * have their own layout without this server-side session check (or the
 * signupConfig/providers prefetch, which only the login/register forms used).
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { TRPCProvider } from "@/lib/trpc/provider";
import { AuthLayoutContent } from "@/components/auth/AuthLayoutContent";
import { validateSession } from "@/server/auth/session";
import { isSignupConfirmed } from "@/server/auth/confirmation";

interface OAuthTransitionLayoutProps {
  children: ReactNode;
}

export default async function OAuthTransitionLayout({ children }: OAuthTransitionLayoutProps) {
  // Check if user is already authenticated
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("session")?.value;

  if (sessionToken) {
    const session = await validateSession(sessionToken);
    if (session) {
      // User is signed in but hasn't completed signup confirmation
      if (!isSignupConfirmed(session.user)) {
        redirect("/complete-signup");
      }
      // User is fully authenticated, redirect to the app
      redirect("/all");
    }
  }

  return (
    <TRPCProvider>
      <AuthLayoutContent>{children}</AuthLayoutContent>
    </TRPCProvider>
  );
}
