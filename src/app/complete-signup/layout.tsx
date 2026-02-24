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
      <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-zinc-950">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <h1 className="ui-text-2xl font-bold text-zinc-900 dark:text-zinc-50">Lion Reader</h1>
            <p className="ui-text-sm mt-2 text-zinc-600 dark:text-zinc-400">
              Complete your account setup
            </p>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            {children}
          </div>
        </div>
      </div>
    </TRPCProvider>
  );
}
