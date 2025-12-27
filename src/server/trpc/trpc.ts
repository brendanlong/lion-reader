/**
 * tRPC Server Setup
 *
 * This module initializes the tRPC instance and defines base procedures.
 * It includes error handling middleware, authentication guards, and rate limiting.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import type { Context } from "./context";
import type { OpenApiMeta } from "trpc-to-openapi";
import {
  checkRateLimit,
  getClientIdentifier,
  getRateLimitHeaders,
  RATE_LIMIT_CONFIGS,
  type RateLimitType,
} from "@/server/rate-limit";

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
  if (!ctx.session || !ctx.sessionToken) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You must be logged in to access this resource",
    });
  }

  return next({
    ctx: {
      ...ctx,
      // Narrow the types: session and sessionToken are guaranteed to be non-null
      session: ctx.session,
      sessionToken: ctx.sessionToken,
    },
  });
});

/**
 * Protected procedure - requires authentication.
 * The session is guaranteed to be non-null in the handler.
 */
export const protectedProcedure = t.procedure.use(timingMiddleware).use(authMiddleware);

// ============================================================================
// Rate Limiting Middleware
// ============================================================================

/**
 * Helper to perform rate limiting check and throw if exceeded.
 * Returns rate limit headers for successful requests.
 */
async function performRateLimitCheck(
  userId: string | null,
  headers: Headers,
  type: RateLimitType
): Promise<Record<string, string>> {
  const identifier = getClientIdentifier(userId, headers);
  const result = await checkRateLimit(identifier, type);

  if (!result.allowed) {
    const config = RATE_LIMIT_CONFIGS[type];
    const rateLimitHeaders = getRateLimitHeaders(result, config);

    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Rate limit exceeded. Please retry after ${result.retryAfterSeconds} seconds.`,
      cause: {
        retryAfter: result.retryAfterSeconds,
        headers: rateLimitHeaders,
      },
    });
  }

  const config = RATE_LIMIT_CONFIGS[type];
  return getRateLimitHeaders(result, config);
}

/**
 * Creates a rate limiting middleware for public procedures.
 * Uses IP address for identification (session may be null).
 */
function createPublicRateLimitMiddleware(type: RateLimitType) {
  return t.middleware(async ({ ctx, next }) => {
    const userId = ctx.session?.user?.id ?? null;
    const rateLimitHeaders = await performRateLimitCheck(userId, ctx.headers, type);

    return next({
      ctx: {
        ...ctx,
        rateLimitHeaders,
      },
    });
  });
}

/**
 * Creates a rate limiting middleware for authenticated procedures.
 * Uses user ID for identification (session is guaranteed non-null).
 * Must be chained after authMiddleware.
 */
function createAuthenticatedRateLimitMiddleware(type: RateLimitType) {
  return t.middleware(async ({ ctx, next }) => {
    // At this point, session is guaranteed non-null due to authMiddleware
    const session = ctx.session;
    const sessionToken = ctx.sessionToken;

    // TypeScript guard to ensure we have authenticated context
    if (!session || !sessionToken) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }

    const rateLimitHeaders = await performRateLimitCheck(session.user.id, ctx.headers, type);

    return next({
      ctx: {
        ...ctx,
        session,
        sessionToken,
        rateLimitHeaders,
      },
    });
  });
}

/**
 * Public procedure with rate limiting.
 * Available to all clients, rate limited by IP address.
 * Uses default rate limits (100 burst, 10/sec refill).
 */
export const rateLimitedPublicProcedure = t.procedure
  .use(timingMiddleware)
  .use(createPublicRateLimitMiddleware("default"));

/**
 * Public procedure with stricter rate limiting for expensive operations.
 * Used for login, register, and other expensive public operations.
 * Uses expensive rate limits (10 burst, 1/sec refill).
 */
export const expensivePublicProcedure = t.procedure
  .use(timingMiddleware)
  .use(createPublicRateLimitMiddleware("expensive"));

/**
 * Protected procedure with rate limiting.
 * Requires authentication and applies rate limiting by user ID.
 * Uses default rate limits (100 burst, 10/sec refill).
 */
export const rateLimitedProtectedProcedure = t.procedure
  .use(timingMiddleware)
  .use(authMiddleware)
  .use(createAuthenticatedRateLimitMiddleware("default"));

/**
 * Protected procedure with stricter rate limiting.
 * Used for expensive authenticated operations like subscribing.
 * Uses expensive rate limits (10 burst, 1/sec refill).
 */
export const expensiveProtectedProcedure = t.procedure
  .use(timingMiddleware)
  .use(authMiddleware)
  .use(createAuthenticatedRateLimitMiddleware("expensive"));

/**
 * Merge routers together
 */
export const mergeRouters = t.mergeRouters;
