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
import { validateSession } from "@/server/auth/session";
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
      if (
        !session.user.tosAgreedAt ||
        !session.user.privacyPolicyAgreedAt ||
        !session.user.notEuAgreedAt
      ) {
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
