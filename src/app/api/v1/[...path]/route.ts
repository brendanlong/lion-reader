/**
 * REST API Route Handler
 *
 * This handles REST requests for the public API.
 * Routes are defined using the openapi meta on tRPC procedures.
 */

import { createOpenApiFetchHandler } from "trpc-to-openapi";
import { appRouter, createContext } from "@/server/trpc";

/**
 * Handle REST API requests
 */
const handler = (req: Request) =>
  createOpenApiFetchHandler({
    endpoint: "/api/v1",
    req,
    router: appRouter,
    createContext,
    onError:
      process.env.NODE_ENV === "development"
        ? ({ error, path }) => {
            console.error(`❌ REST API failed on ${path ?? "<no-path>"}: ${error.message}`);
          }
        : undefined,
  });

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
