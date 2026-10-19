/**
 * OAuth Transition Layout
 *
 * Server component wrapper for /auth/oauth/complete. No signed-in redirect here:
 * the OAuth callback sends a freshly signed-in browser to that page, which must
 * render to broadcast the sign-in and follow its `?redirect=` (#2029).
 */

import type { ReactNode } from "react";
import { TRPCProvider } from "@/lib/trpc/provider";
import { AuthLayoutContent } from "@/components/auth/AuthLayoutContent";

interface OAuthTransitionLayoutProps {
  children: ReactNode;
}

export default function OAuthTransitionLayout({ children }: OAuthTransitionLayoutProps) {
  return (
    <TRPCProvider>
      <AuthLayoutContent>{children}</AuthLayoutContent>
    </TRPCProvider>
  );
}
