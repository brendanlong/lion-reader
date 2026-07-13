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
import type { ApiTokenScope } from "@/server/auth/api-token";
import {
  checkRateLimit,
  getClientIdentifier,
  getRateLimitHeaders,
  RATE_LIMIT_CONFIGS,
  type RateLimitType,
} from "@/server/rate-limit";
import { signupConfig } from "@/server/config/env";
import { errors, getAppErrorCode, isExpectedClientError } from "./errors";
import {
  ADMIN_COOKIE_NAME,
  validateAdminSessionToken,
  validateAdminSecret,
} from "@/server/auth/admin-session";
import { logger } from "@/lib/logger";
import * as Sentry from "@sentry/nextjs";

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
      // Extract our custom app error code from cause (set by createError in errors.ts)
      const appErrorCode = getAppErrorCode(error);

      return {
        ...shape,
        data: {
          ...shape.data,
          // Custom app error code (e.g. SIGNUP_CONFIRMATION_REQUIRED, INVITE_REQUIRED)
          appErrorCode,
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
 * Middleware that logs request timing and captures errors
 */
const timingMiddleware = t.middleware(async ({ path, type, next, ctx }) => {
  const start = Date.now();

  try {
    const result = await next();
    const duration = Date.now() - start;

    // Log slow requests
    if (duration > 1000) {
      logger.warn("Slow tRPC request", {
        path,
        type,
        durationMs: duration,
        userId: ctx.session?.user?.id,
      });
    }

    return result;
  } catch (error) {
    const duration = Date.now() - start;

    // Log the error
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const isTRPCError = error instanceof TRPCError;

    // Only log unexpected errors (not client errors like UNAUTHORIZED, NOT_FOUND,
    // nor expected upstream conditions like SITE_BLOCKED that map to a 5xx status
    // but aren't server bugs — see isExpectedClientError)
    if (
      !isTRPCError ||
      (!["UNAUTHORIZED", "NOT_FOUND", "BAD_REQUEST", "FORBIDDEN"].includes(error.code) &&
        !isExpectedClientError(error))
    ) {
      logger.error("tRPC request failed", {
        path,
        type,
        durationMs: duration,
        error: errorMessage,
        userId: ctx.session?.user?.id,
      });

      // Report non-client errors to Sentry
      Sentry.captureException(error, {
        tags: { trpcPath: path, trpcType: type },
        extra: {
          durationMs: duration,
          userId: ctx.session?.user?.id,
        },
      });
    }

    throw error;
  }
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
 * Middleware that rejects API token / OAuth token auth, allowing only browser
 * sessions. This makes scope enforcement fail-closed: any endpoint that does not
 * explicitly opt into a token scope (via `scopedProtectedProcedure`) is
 * session-only, so tokens cannot reach account-management or other sensitive
 * operations even though they produce a synthetic session in the context.
 *
 * Must be chained after authMiddleware.
 */
const sessionOnlyMiddleware = t.middleware(({ ctx, next }) => {
  if (ctx.authType !== "session") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "API tokens cannot access this endpoint; it requires a logged-in session",
    });
  }
  // session/sessionToken are guaranteed non-null for session auth (authMiddleware
  // ran first); re-pass them so downstream procedures keep the narrowed types.
  return next({
    ctx: {
      ...ctx,
      session: ctx.session!,
      sessionToken: ctx.sessionToken!,
    },
  });
});

/**
 * Protected procedure - requires a browser session (not an API token).
 * The session is guaranteed to be non-null in the handler.
 * Does NOT require signup confirmation — use for auth management endpoints
 * (auth.me, auth.confirmSignup, auth.logout, etc.)
 */
export const protectedProcedure = t.procedure
  .use(timingMiddleware)
  .use(authMiddleware)
  .use(sessionOnlyMiddleware);

/**
 * Middleware that enforces signup confirmation.
 * Throws FORBIDDEN with SIGNUP_CONFIRMATION_REQUIRED code if the user
 * has not completed the signup confirmation flow (ToS, Privacy, EU check).
 * Must be chained after authMiddleware.
 */
const confirmedMiddleware = t.middleware(({ ctx, next }) => {
  const session = ctx.session!;
  const sessionToken = ctx.sessionToken!;

  const { tosAgreedAt, privacyPolicyAgreedAt, notEuAgreedAt } = session.user;
  if (!tosAgreedAt || !privacyPolicyAgreedAt || !notEuAgreedAt) {
    throw errors.signupConfirmationRequired();
  }

  return next({
    ctx: {
      ...ctx,
      session,
      sessionToken,
    },
  });
});

/**
 * Confirmed protected procedure - requires authentication AND signup confirmation.
 * Use this for all regular app endpoints. Users who haven't completed signup
 * confirmation will get a SIGNUP_CONFIRMATION_REQUIRED error.
 */
export const confirmedProtectedProcedure = t.procedure
  .use(timingMiddleware)
  .use(authMiddleware)
  .use(sessionOnlyMiddleware)
  .use(confirmedMiddleware);

// ============================================================================
// Scope Enforcement Middleware
// ============================================================================

/**
 * Creates a middleware that enforces API token scopes.
 * Session-based auth (browser) has full access; tokens must hold at least one
 * of the required scopes (any-of).
 *
 * Must be chained after authMiddleware to receive narrowed types.
 */
function createScopeMiddleware(requiredScopes: ApiTokenScope[]) {
  return t.middleware(({ ctx, next }) => {
    // Session and sessionToken are guaranteed non-null after authMiddleware
    const session = ctx.session!;
    const sessionToken = ctx.sessionToken!;

    // Token auth (API token / OAuth) must hold one of the required scopes.
    // Session auth (browser) has full access - no scope restrictions.
    if (ctx.authType !== "session") {
      const hasScope = requiredScopes.some((scope) => ctx.scopes.includes(scope));
      if (!hasScope) {
        const list = requiredScopes.map((s) => `'${s}'`).join(" or ");
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `This operation requires the ${list} scope`,
        });
      }
    }

    // Pass through the narrowed types from authMiddleware
    return next({
      ctx: {
        ...ctx,
        session,
        sessionToken,
      },
    });
  });
}

/**
 * Creates a protected procedure that requires an API token scope.
 * Session-based auth has full access; tokens must hold at least one of the
 * specified scopes. Also requires signup confirmation.
 *
 * @param scopes - The required scope(s) for token access (any-of)
 */
export function scopedProtectedProcedure(scopes: ApiTokenScope | ApiTokenScope[]) {
  const requiredScopes = Array.isArray(scopes) ? scopes : [scopes];
  return t.procedure
    .use(timingMiddleware)
    .use(authMiddleware)
    .use(confirmedMiddleware)
    .use(createScopeMiddleware(requiredScopes));
}

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
 * Public procedure with stricter rate limiting for expensive operations.
 * Used for login, register, and other expensive public operations.
 * Uses expensive rate limits (10 burst, 1/sec refill).
 */
export const expensivePublicProcedure = t.procedure
  .use(timingMiddleware)
  .use(createPublicRateLimitMiddleware("expensive"));

/**
 * Protected procedure with stricter rate limiting.
 * Used for expensive authenticated operations like subscribing.
 * Uses expensive rate limits (10 burst, 1/sec refill).
 * Does NOT require signup confirmation — use for auth management endpoints.
 */
export const expensiveProtectedProcedure = t.procedure
  .use(timingMiddleware)
  .use(authMiddleware)
  .use(sessionOnlyMiddleware)
  .use(createAuthenticatedRateLimitMiddleware("expensive"));

/**
 * Confirmed protected procedure with stricter rate limiting.
 * Used for expensive authenticated operations that require confirmed signup.
 * Uses expensive rate limits (10 burst, 1/sec refill).
 */
export const expensiveConfirmedProtectedProcedure = t.procedure
  .use(timingMiddleware)
  .use(authMiddleware)
  .use(sessionOnlyMiddleware)
  .use(confirmedMiddleware)
  .use(createAuthenticatedRateLimitMiddleware("expensive"));

// ============================================================================
// Admin Procedures (protected by ALLOWLIST_SECRET)
// ============================================================================

/**
 * Middleware that enforces admin authentication.
 * Accepts either:
 * 1. An httpOnly `admin_session` cookie (signed HMAC token from /api/admin/session)
 * 2. A Bearer token matching ALLOWLIST_SECRET (for programmatic API access)
 */
const adminMiddleware = t.middleware(({ ctx, next }) => {
  if (!signupConfig.allowlistSecret) {
    throw errors.adminSecretNotConfigured();
  }

  // Check for admin session cookie
  const cookieHeader = ctx.headers.get("cookie");
  if (cookieHeader) {
    const cookies = Object.fromEntries(
      cookieHeader.split(/;\s*/).map((c) => {
        const [key, ...value] = c.split("=");
        return [key, value.join("=")];
      })
    );
    const sessionToken = cookies[ADMIN_COOKIE_NAME];
    if (sessionToken && validateAdminSessionToken(sessionToken)) {
      return next({ ctx });
    }
  }

  // Fallback: check Bearer token (for programmatic access)
  const authHeader = ctx.headers.get("authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1] && validateAdminSecret(match[1])) {
      return next({ ctx });
    }
  }

  throw errors.adminUnauthorized();
});

/**
 * Admin procedure - requires admin_session cookie or ALLOWLIST_SECRET Bearer token.
 * Used for managing invites and other admin operations.
 */
export const adminProcedure = t.procedure.use(timingMiddleware).use(adminMiddleware);
