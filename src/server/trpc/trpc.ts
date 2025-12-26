/**
 * tRPC Server Setup
 *
 * This module initializes the tRPC instance and defines base procedures.
 * It includes error handling middleware and authentication guards.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { Context } from "./context";
import type { OpenApiMeta } from "trpc-to-openapi";

/**
 * Initialize tRPC with our context type and superjson transformer.
 * SuperJSON allows serializing Date, Map, Set, etc.
 */
const t = initTRPC
  .context<Context>()
  .meta<OpenApiMeta>()
  .create({
    transformer: superjson,
    errorFormatter({ shape, error }) {
      return {
        ...shape,
        data: {
          ...shape.data,
          // Include Zod validation errors in response
          zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
        },
      };
    },
  });

/**
 * Export reusable router and procedure helpers
 */
export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;

/**
 * Middleware that logs request timing
 */
const timingMiddleware = t.middleware(async ({ path, type, next }) => {
  const start = Date.now();
  const result = await next();
  const duration = Date.now() - start;

  if (duration > 1000) {
    console.warn(`Slow ${type} '${path}': ${duration}ms`);
  }

  return result;
});

/**
 * Public procedure - no authentication required.
 * Available to all clients.
 */
export const publicProcedure = t.procedure.use(timingMiddleware);

/**
 * Middleware that enforces authentication.
 * Throws UNAUTHORIZED if no valid session exists.
 */
const authMiddleware = t.middleware(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You must be logged in to access this resource",
    });
  }

  return next({
    ctx: {
      ...ctx,
      // Narrow the type: session is guaranteed to be non-null
      session: ctx.session,
    },
  });
});

/**
 * Protected procedure - requires authentication.
 * The session is guaranteed to be non-null in the handler.
 */
export const protectedProcedure = t.procedure.use(timingMiddleware).use(authMiddleware);

/**
 * Merge routers together
 */
export const mergeRouters = t.mergeRouters;
