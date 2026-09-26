/**
 * Complete Signup Layout
 *
 * Server component wrapper for the signup confirmation page.
 * Requires authentication but NOT confirmation (that's what this page does).
 * Redirects unauthenticated users to login and already-confirmed users to /all.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { TRPCProvider } from "@/lib/trpc/provider";
import { AuthErrorHandler } from "@/components/app/AuthErrorHandler";
import { AuthLayoutContent } from "@/components/auth/AuthLayoutContent";
import { validateSession } from "@/server/auth/session";
import { isSignupConfirmed } from "@/server/auth/confirmation";

interface CompleteSignupLayoutProps {
  children: ReactNode;
}

export default async function CompleteSignupLayout({ children }: CompleteSignupLayoutProps) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("session")?.value;
  const session = sessionToken ? await validateSession(sessionToken) : null;

  if (!session) {
    redirect("/login");
  }

  // Already confirmed, go to app
  if (isSignupConfirmed(session.user)) {
    redirect("/all");
  }

  return (
    <TRPCProvider>
      {/* Authenticated surface: a dead session mid-page should redirect to /login,
          like the SPA. The signup-confirmation branch self-guards this path. */}
      <AuthErrorHandler />
      <AuthLayoutContent subtitle="Complete your account setup">{children}</AuthLayoutContent>
    </TRPCProvider>
  );
}
