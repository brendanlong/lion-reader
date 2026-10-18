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

import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { TRPCProvider } from "@/lib/trpc/provider";
import { AuthLayoutContent } from "@/components/auth/AuthLayoutContent";
import { getRequestSession } from "@/server/auth/request-session";
import { sessionHomePath } from "@/server/auth/confirmation";

interface OAuthTransitionLayoutProps {
  children: ReactNode;
}

export default async function OAuthTransitionLayout({ children }: OAuthTransitionLayoutProps) {
  const current = await getRequestSession();
  if (current) {
    // Signed in: into the app, or to signup confirmation if incomplete.
    redirect(sessionHomePath(current.session.user));
  }

  return (
    <TRPCProvider>
      <AuthLayoutContent>{children}</AuthLayoutContent>
    </TRPCProvider>
  );
}
