/**
 * tRPC Provider
 *
 * Wraps the application with React Query and tRPC providers.
 * This must be used at the root of the app for tRPC hooks to work.
 */

"use client";

import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, type TRPCLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@/server/trpc/root";
import { trpc } from "./client";
import { getQueryClient } from "./query-client";

/**
 * Get the base URL for API requests.
 * Uses window.location in browser, empty string on server.
 *
 * Note: auth-error handling (UNAUTHORIZED → /login, SIGNUP_CONFIRMATION_REQUIRED →
 * /complete-signup) is deliberately NOT here. It lives in `<AuthErrorHandler>`,
 * mounted only inside the authenticated app SPA — see that component. TRPCProvider
 * is generic wiring shared by auth/demo/save surfaces where a global auth redirect
 * would be wrong.
 */
function getBaseUrl() {
  if (typeof window !== "undefined") {
    // Browser: use relative URL
    return "";
  }
  // SSR: use localhost
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

function createHttpLinks(): TRPCLink<AppRouter>[] {
  return [
    httpBatchLink({
      url: `${getBaseUrl()}/api/trpc`,
      transformer: superjson,
      // Include credentials for cookie-based auth
      fetch(url, options) {
        return fetch(url, {
          ...options,
          credentials: "include",
        });
      },
    }),
  ];
}

interface TRPCProviderProps {
  /**
   * Link chain override. Defaults to the batching HTTP link against
   * `/api/trpc`; the public demo passes an in-process handler link
   * (`createHandlerLink`) so the same hooks resolve from canned data.
   */
  links?: TRPCLink<AppRouter>[];
  children: ReactNode;
}

/**
 * TRPC Provider component.
 * Wrap your app with this to enable tRPC hooks.
 *
 * @example
 * ```tsx
 * // In your root layout:
 * <TRPCProvider>
 *   {children}
 * </TRPCProvider>
 * ```
 */
export function TRPCProvider({ links, children }: TRPCProviderProps) {
  // Use the shared QueryClient from query-client.ts
  // This ensures server prefetching and client components use the same instance
  // during SSR, preventing hydration mismatches.
  const queryClient = getQueryClient();

  const [trpcClient] = useState(() => trpc.createClient({ links: links ?? createHttpLinks() }));

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
