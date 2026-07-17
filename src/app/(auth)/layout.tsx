/**
 * Auth Layout
 *
 * Server component wrapper for authentication pages.
 * Redirects authenticated users to /all.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { TRPCProvider } from "@/lib/trpc/provider";
import { createHydrationHelpersForRequest } from "@/lib/trpc/server";
import { validateSession } from "@/server/auth/session";
import { isSignupConfirmed } from "@/server/auth/confirmation";
import { AuthLayoutContent } from "./AuthLayoutContent";

interface AuthLayoutProps {
  children: ReactNode;
}

export default async function AuthLayout({ children }: AuthLayoutProps) {
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

  // Prefetch the config the login/register forms depend on so their
  // config-driven content renders in the SSR HTML instead of flashing a loading
  // state and popping in once the client queries resolve. Both are static server
  // env (which signup providers are allowed / which OAuth providers are
  // configured), so awaiting them is cheap and lets the queries hydrate as
  // already-settled data:
  //   - auth.signupConfig: invite-required state, allowed signup providers, the
  //     "Create one" link, and the register email form.
  //   - auth.providers: which OAuth provider buttons (Google/Apple/Discord) to
  //     render — OAuthSignInButton returns null until this resolves.
  // See #1328.
  const { trpc, HydrateClient } = await createHydrationHelpersForRequest();
  await Promise.all([trpc.auth.signupConfig.prefetch(), trpc.auth.providers.prefetch()]);

  return (
    <TRPCProvider>
      <HydrateClient>
        <AuthLayoutContent>{children}</AuthLayoutContent>
      </HydrateClient>
    </TRPCProvider>
  );
}
