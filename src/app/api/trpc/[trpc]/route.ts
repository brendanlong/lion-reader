/**
 * tRPC API Route Handler
 *
 * This is the main entry point for tRPC requests.
 * All tRPC procedures are accessible at /api/trpc/*
 */

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/trpc/root";
import { createContext } from "@/server/trpc/context";
import { serveTrpcHttp, withFailingBody } from "@/server/trpc/http";

/**
 * Normalizes the tRPC path for metrics.
 * Extracts the procedure name from the URL path.
 *
 * Example: /api/trpc/entries.list,entries.get → /api/trpc/entries.list
 * (For batched requests, we use the first procedure as the path)
 */
function normalizeTrpcPath(url: URL): string {
  const pathname = url.pathname;
  // Extract procedure from path like /api/trpc/entries.list
  const trpcPath = pathname.replace("/api/trpc/", "");

  // For batched requests (comma-separated), use the first procedure
  const firstProcedure = trpcPath.split(",")[0] || "unknown";

  return `/api/trpc/${firstProcedure}`;
}

const serve = (req: Request, onError?: Parameters<typeof fetchRequestHandler>[0]["onError"]) =>
  fetchRequestHandler({ endpoint: "/api/trpc", req, router: appRouter, createContext, onError });

const handler = (req: Request): Promise<Response> =>
  serveTrpcHttp(
    req,
    {
      label: "tRPC",
      metricsPath: normalizeTrpcPath(new URL(req.url)),
      reject: (error, onError) => serve(withFailingBody(req, error), onError),
    },
    serve
  );

export { handler as GET, handler as POST };
