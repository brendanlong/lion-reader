/**
 * Public Auth Layout
 *
 * Layout for the login/register pages: the centered card shell, the tRPC
 * provider the forms need, and the SSR'd signup/provider config.
 *
 * These pages are statically prerendered (issue #1359), so this layout reads
 * NO request data — no `cookies()` session check (the redirect for
 * already-authenticated visitors lives in `src/proxy.ts` instead) and no
 * request-bound tRPC helpers. The signupConfig/providers prefetch (#1328 —
 * OAuth buttons, invite-required state, the signup link, the EU notice in the
 * SSR HTML instead of a client-side pop-in) is preserved through
 * `createStaticHydrationHelpers`, which calls the env-only procedures with an
 * anonymous context: the config gets baked into the prerendered HTML.
 *
 * Because that bake happens at `next build` (with build-machine env, which in
 * CI/Docker is NOT the runtime env), the custom server re-renders these pages
 * at every process startup via the revalidate-public route — the config can't
 * change after startup, so startup freshness is exactly enough. See
 * `scripts/server.ts` and `src/app/api/internal/revalidate-public/route.ts`.
 */

import type { ReactNode } from "react";
import { TRPCProvider } from "@/lib/trpc/provider";
import { createStaticHydrationHelpers } from "@/lib/trpc/server";
import { AuthLayoutContent } from "@/components/auth/AuthLayoutContent";

interface PublicAuthLayoutProps {
  children: ReactNode;
}

export default async function PublicAuthLayout({ children }: PublicAuthLayoutProps) {
  const { trpc, HydrateClient } = await createStaticHydrationHelpers();
  await Promise.all([trpc.auth.signupConfig.prefetch(), trpc.auth.providers.prefetch()]);

  return (
    <TRPCProvider>
      <HydrateClient>
        <AuthLayoutContent>{children}</AuthLayoutContent>
      </HydrateClient>
    </TRPCProvider>
  );
}
