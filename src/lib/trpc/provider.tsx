/**
 * tRPC Provider
 *
 * Wraps the application with React Query and tRPC providers.
 * This must be used at the root of the app for tRPC hooks to work.
 */

"use client";

import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
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

interface TRPCProviderProps {
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
export function TRPCProvider({ children }: TRPCProviderProps) {
  // Use the shared QueryClient from query-client.ts
  // This ensures server prefetching and client components use the same instance
  // during SSR, preventing hydration mismatches.
  const queryClient = getQueryClient();

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
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
      ],
    })
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
