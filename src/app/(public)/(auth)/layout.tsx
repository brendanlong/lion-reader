/**
 * Public Auth Layout
 *
 * Layout for the login/register pages: the centered card shell plus the tRPC
 * provider the forms need for their client-side mutations and config queries.
 *
 * Unlike the old shared auth layout, this deliberately reads NO request data —
 * no `cookies()` session check and no server-side signupConfig/providers
 * prefetch — so both pages can be statically prerendered (issue #1359). The
 * consequences are accepted trade-offs:
 *
 * - An already-authenticated user who opens /login or /register sees the form
 *   instead of being bounced to /all (logging in again still works; the app
 *   layout keeps its own guards).
 * - Config-driven content (OAuth provider buttons, invite-required state, the
 *   signup link) is fetched client-side and pops in after hydration, instead
 *   of being SSR'd (this reverts the #1328 SSR prefetch in exchange for
 *   serving the pages statically). The forms themselves are in the static
 *   HTML, and validation/OAuth errors were always client-rendered.
 */

import type { ReactNode } from "react";
import { TRPCProvider } from "@/lib/trpc/provider";
import { AuthLayoutContent } from "@/components/auth/AuthLayoutContent";

interface PublicAuthLayoutProps {
  children: ReactNode;
}

export default function PublicAuthLayout({ children }: PublicAuthLayoutProps) {
  return (
    <TRPCProvider>
      <AuthLayoutContent>{children}</AuthLayoutContent>
    </TRPCProvider>
  );
}
