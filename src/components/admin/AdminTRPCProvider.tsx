"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "@/lib/trpc/client";

function getBaseUrl() {
  if (typeof window !== "undefined") {
    return "";
  }
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

interface AdminTRPCProviderProps {
  token: string;
  children: ReactNode;
}

/**
 * tRPC provider for admin pages.
 * Uses Bearer token auth instead of cookie-based session auth.
 */
export function AdminTRPCProvider({ token, children }: AdminTRPCProviderProps) {
  const [queryClient] = useState(() => new QueryClient());

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
          headers() {
            return {
              Authorization: `Bearer ${token}`,
            };
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
