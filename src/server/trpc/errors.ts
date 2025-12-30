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
  ADMIN_UNAUTHORIZED: "ADMIN_UNAUTHORIZED",

  // Authorization errors (403)
  FORBIDDEN: "FORBIDDEN",
  ADMIN_SECRET_NOT_CONFIGURED: "ADMIN_SECRET_NOT_CONFIGURED",

  // Not found errors (404)
  NOT_FOUND: "NOT_FOUND",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  FEED_NOT_FOUND: "FEED_NOT_FOUND",
  ENTRY_NOT_FOUND: "ENTRY_NOT_FOUND",
  SUBSCRIPTION_NOT_FOUND: "SUBSCRIPTION_NOT_FOUND",
  TAG_NOT_FOUND: "TAG_NOT_FOUND",
  SAVED_ARTICLE_NOT_FOUND: "SAVED_ARTICLE_NOT_FOUND",
  INGEST_ADDRESS_NOT_FOUND: "INGEST_ADDRESS_NOT_FOUND",

  // Validation errors (400)
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_EMAIL: "INVALID_EMAIL",
  WEAK_PASSWORD: "WEAK_PASSWORD",
  EMAIL_ALREADY_EXISTS: "EMAIL_ALREADY_EXISTS",
  OAUTH_STATE_INVALID: "OAUTH_STATE_INVALID",
  OAUTH_PROVIDER_NOT_CONFIGURED: "OAUTH_PROVIDER_NOT_CONFIGURED",
  OAUTH_CALLBACK_FAILED: "OAUTH_CALLBACK_FAILED",
  INVITE_REQUIRED: "INVITE_REQUIRED",
  INVITE_INVALID: "INVITE_INVALID",
  INVITE_EXPIRED: "INVITE_EXPIRED",
  INVITE_ALREADY_USED: "INVITE_ALREADY_USED",
  MAX_INGEST_ADDRESSES_REACHED: "MAX_INGEST_ADDRESSES_REACHED",

  // Conflict errors (409)
  ALREADY_SUBSCRIBED: "ALREADY_SUBSCRIBED",
  OAUTH_ALREADY_LINKED: "OAUTH_ALREADY_LINKED",
  CANNOT_UNLINK_ONLY_AUTH: "CANNOT_UNLINK_ONLY_AUTH",

  // Rate limiting (429)
  RATE_LIMITED: "RATE_LIMITED",

  // Server errors (500)
  INTERNAL_ERROR: "INTERNAL_ERROR",
  FEED_FETCH_ERROR: "FEED_FETCH_ERROR",
  PARSE_ERROR: "PARSE_ERROR",
  SAVED_ARTICLE_FETCH_ERROR: "SAVED_ARTICLE_FETCH_ERROR",
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
  ADMIN_UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  ADMIN_SECRET_NOT_CONFIGURED: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  USER_NOT_FOUND: "NOT_FOUND",
  FEED_NOT_FOUND: "NOT_FOUND",
  ENTRY_NOT_FOUND: "NOT_FOUND",
  SUBSCRIPTION_NOT_FOUND: "NOT_FOUND",
  TAG_NOT_FOUND: "NOT_FOUND",
  SAVED_ARTICLE_NOT_FOUND: "NOT_FOUND",
  INGEST_ADDRESS_NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "BAD_REQUEST",
  INVALID_EMAIL: "BAD_REQUEST",
  WEAK_PASSWORD: "BAD_REQUEST",
  EMAIL_ALREADY_EXISTS: "BAD_REQUEST",
  OAUTH_STATE_INVALID: "BAD_REQUEST",
  OAUTH_PROVIDER_NOT_CONFIGURED: "BAD_REQUEST",
  OAUTH_CALLBACK_FAILED: "BAD_REQUEST",
  INVITE_REQUIRED: "BAD_REQUEST",
  INVITE_INVALID: "BAD_REQUEST",
  INVITE_EXPIRED: "BAD_REQUEST",
  INVITE_ALREADY_USED: "BAD_REQUEST",
  MAX_INGEST_ADDRESSES_REACHED: "BAD_REQUEST",
  ALREADY_SUBSCRIBED: "CONFLICT",
  OAUTH_ALREADY_LINKED: "CONFLICT",
  CANNOT_UNLINK_ONLY_AUTH: "BAD_REQUEST",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  INTERNAL_ERROR: "INTERNAL_SERVER_ERROR",
  FEED_FETCH_ERROR: "INTERNAL_SERVER_ERROR",
  PARSE_ERROR: "INTERNAL_SERVER_ERROR",
  SAVED_ARTICLE_FETCH_ERROR: "INTERNAL_SERVER_ERROR",
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

  tagNotFound: () => createError(ErrorCodes.TAG_NOT_FOUND, "Tag not found"),

  ingestAddressNotFound: () =>
    createError(ErrorCodes.INGEST_ADDRESS_NOT_FOUND, "Ingest address not found"),

  maxIngestAddressesReached: (limit: number) =>
    createError(
      ErrorCodes.MAX_INGEST_ADDRESSES_REACHED,
      `Maximum number of ingest addresses (${limit}) reached`
    ),

  validation: (message: string, details?: Record<string, unknown>) =>
    createError(ErrorCodes.VALIDATION_ERROR, message, details),

  emailExists: () =>
    createError(ErrorCodes.EMAIL_ALREADY_EXISTS, "An account with this email already exists"),

  oauthStateInvalid: () =>
    createError(
      ErrorCodes.OAUTH_STATE_INVALID,
      "Invalid or expired OAuth state. Please try signing in again."
    ),

  oauthProviderNotConfigured: (provider: string) =>
    createError(
      ErrorCodes.OAUTH_PROVIDER_NOT_CONFIGURED,
      `${provider} OAuth is not configured on this server`
    ),

  oauthCallbackFailed: (reason: string) =>
    createError(ErrorCodes.OAUTH_CALLBACK_FAILED, `OAuth callback failed: ${reason}`),

  alreadySubscribed: () =>
    createError(ErrorCodes.ALREADY_SUBSCRIBED, "You are already subscribed to this feed"),

  oauthAlreadyLinked: (provider: string) =>
    createError(
      ErrorCodes.OAUTH_ALREADY_LINKED,
      `A ${provider} account is already linked to your account`
    ),

  cannotUnlinkOnlyAuth: () =>
    createError(
      ErrorCodes.CANNOT_UNLINK_ONLY_AUTH,
      "Cannot unlink this account because it is your only authentication method. Add a password first."
    ),

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

  savedArticleNotFound: () =>
    createError(ErrorCodes.SAVED_ARTICLE_NOT_FOUND, "Saved article not found"),

  savedArticleFetchError: (url: string, reason: string) =>
    createError(ErrorCodes.SAVED_ARTICLE_FETCH_ERROR, `Failed to fetch page: ${reason}`, {
      url,
    }),

  // Invite errors
  inviteRequired: () =>
    createError(ErrorCodes.INVITE_REQUIRED, "An invite is required to register"),

  inviteInvalid: () => createError(ErrorCodes.INVITE_INVALID, "Invalid invite token"),

  inviteExpired: () => createError(ErrorCodes.INVITE_EXPIRED, "Invite token has expired"),

  inviteAlreadyUsed: () =>
    createError(ErrorCodes.INVITE_ALREADY_USED, "Invite token has already been used"),

  // Admin errors
  adminSecretNotConfigured: () =>
    createError(
      ErrorCodes.ADMIN_SECRET_NOT_CONFIGURED,
      "Admin API is not configured on this server"
    ),

  adminUnauthorized: () => createError(ErrorCodes.ADMIN_UNAUTHORIZED, "Invalid admin secret"),
};
