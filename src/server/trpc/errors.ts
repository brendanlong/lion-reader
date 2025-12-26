/**
 * tRPC Error Helpers
 *
 * Provides consistent error creation and handling across the API.
 * All errors follow the format: { error: { code, message, details? } }
 */

import { TRPCError } from "@trpc/server";

/**
 * Error codes used across the API.
 * These are mapped to appropriate HTTP status codes.
 */
export const ErrorCodes = {
  // Authentication errors (401)
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  SESSION_EXPIRED: "SESSION_EXPIRED",

  // Authorization errors (403)
  FORBIDDEN: "FORBIDDEN",

  // Not found errors (404)
  NOT_FOUND: "NOT_FOUND",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  FEED_NOT_FOUND: "FEED_NOT_FOUND",
  ENTRY_NOT_FOUND: "ENTRY_NOT_FOUND",
  SUBSCRIPTION_NOT_FOUND: "SUBSCRIPTION_NOT_FOUND",

  // Validation errors (400)
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_EMAIL: "INVALID_EMAIL",
  WEAK_PASSWORD: "WEAK_PASSWORD",
  EMAIL_ALREADY_EXISTS: "EMAIL_ALREADY_EXISTS",

  // Conflict errors (409)
  ALREADY_SUBSCRIBED: "ALREADY_SUBSCRIBED",

  // Rate limiting (429)
  RATE_LIMITED: "RATE_LIMITED",

  // Server errors (500)
  INTERNAL_ERROR: "INTERNAL_ERROR",
  FEED_FETCH_ERROR: "FEED_FETCH_ERROR",
  PARSE_ERROR: "PARSE_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Maps our error codes to tRPC error codes
 */
const errorCodeToTRPCCode: Record<
  ErrorCode,
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "CONFLICT"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL_SERVER_ERROR"
> = {
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_CREDENTIALS: "UNAUTHORIZED",
  SESSION_EXPIRED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  USER_NOT_FOUND: "NOT_FOUND",
  FEED_NOT_FOUND: "NOT_FOUND",
  ENTRY_NOT_FOUND: "NOT_FOUND",
  SUBSCRIPTION_NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "BAD_REQUEST",
  INVALID_EMAIL: "BAD_REQUEST",
  WEAK_PASSWORD: "BAD_REQUEST",
  EMAIL_ALREADY_EXISTS: "BAD_REQUEST",
  ALREADY_SUBSCRIBED: "CONFLICT",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  INTERNAL_ERROR: "INTERNAL_SERVER_ERROR",
  FEED_FETCH_ERROR: "INTERNAL_SERVER_ERROR",
  PARSE_ERROR: "INTERNAL_SERVER_ERROR",
};

/**
 * Creates a TRPCError with consistent formatting.
 *
 * @param code - The application error code
 * @param message - Human-readable error message
 * @param details - Optional additional context
 */
export function createError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>
): TRPCError {
  const trpcCode = errorCodeToTRPCCode[code];

  return new TRPCError({
    code: trpcCode,
    message,
    cause: details ? { code, details } : { code },
  });
}

/**
 * Convenience functions for common errors
 */
export const errors = {
  unauthorized: (message = "You must be logged in") =>
    createError(ErrorCodes.UNAUTHORIZED, message),

  invalidCredentials: () =>
    createError(ErrorCodes.INVALID_CREDENTIALS, "Invalid email or password"),

  sessionExpired: () => createError(ErrorCodes.SESSION_EXPIRED, "Your session has expired"),

  forbidden: (message = "You don't have permission to access this resource") =>
    createError(ErrorCodes.FORBIDDEN, message),

  notFound: (resource: string) => createError(ErrorCodes.NOT_FOUND, `${resource} not found`),

  userNotFound: () => createError(ErrorCodes.USER_NOT_FOUND, "User not found"),

  feedNotFound: () => createError(ErrorCodes.FEED_NOT_FOUND, "Feed not found"),

  entryNotFound: () => createError(ErrorCodes.ENTRY_NOT_FOUND, "Entry not found"),

  subscriptionNotFound: () =>
    createError(ErrorCodes.SUBSCRIPTION_NOT_FOUND, "Subscription not found"),

  validation: (message: string, details?: Record<string, unknown>) =>
    createError(ErrorCodes.VALIDATION_ERROR, message, details),

  emailExists: () =>
    createError(ErrorCodes.EMAIL_ALREADY_EXISTS, "An account with this email already exists"),

  alreadySubscribed: () =>
    createError(ErrorCodes.ALREADY_SUBSCRIBED, "You are already subscribed to this feed"),

  rateLimited: (retryAfter?: number) =>
    createError(ErrorCodes.RATE_LIMITED, "Too many requests", { retryAfter }),

  internal: (message = "An unexpected error occurred") =>
    createError(ErrorCodes.INTERNAL_ERROR, message),

  feedFetchError: (url: string, reason: string) =>
    createError(ErrorCodes.FEED_FETCH_ERROR, `Failed to fetch feed: ${reason}`, {
      url,
    }),

  parseError: (reason: string) =>
    createError(ErrorCodes.PARSE_ERROR, `Failed to parse feed: ${reason}`),
};
