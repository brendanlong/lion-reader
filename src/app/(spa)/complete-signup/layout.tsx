/**
 * Complete Signup Layout
 *
 * Server component wrapper for the signup confirmation page.
 * Requires authentication but NOT confirmation (that's what this page does).
 * Redirects unauthenticated users to login and already-confirmed users to /all.
 */

import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { TRPCProvider } from "@/lib/trpc/provider";
import { AuthErrorHandler } from "@/components/app/AuthErrorHandler";
import { AuthLayoutContent } from "@/components/auth/AuthLayoutContent";
import { getRequestSession } from "@/server/auth/request-session";
import { isSignupConfirmed } from "@/server/auth/confirmation";

interface CompleteSignupLayoutProps {
  children: ReactNode;
}

export default async function CompleteSignupLayout({ children }: CompleteSignupLayoutProps) {
  const current = await getRequestSession();
  if (!current) {
    redirect("/login");
  }

  // Already confirmed, go to app
  if (isSignupConfirmed(current.session.user)) {
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
