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
import { validateSession } from "@/server/auth/session";

interface CompleteSignupLayoutProps {
  children: ReactNode;
}

export default async function CompleteSignupLayout({ children }: CompleteSignupLayoutProps) {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("session")?.value;

  if (!sessionToken) {
    redirect("/login");
  }

  const session = await validateSession(sessionToken);
  if (!session) {
    redirect("/login");
  }

  // Already confirmed, go to app
  if (
    session.user.tosAgreedAt &&
    session.user.privacyPolicyAgreedAt &&
    session.user.notEuAgreedAt
  ) {
    redirect("/all");
  }

  return (
    <TRPCProvider>
      <div className="bg-canvas flex min-h-screen flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <h1 className="ui-text-2xl text-strong font-bold">Lion Reader</h1>
            <p className="ui-text-sm text-muted mt-2">Complete your account setup</p>
          </div>

          <div className="border-edge bg-surface rounded-lg border p-6 shadow-sm">{children}</div>
        </div>
      </div>
    </TRPCProvider>
  );
}
