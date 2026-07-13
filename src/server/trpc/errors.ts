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
const ErrorCodes = {
  // Authentication errors (401)
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  ADMIN_UNAUTHORIZED: "ADMIN_UNAUTHORIZED",

  // Authorization errors (403)
  FORBIDDEN: "FORBIDDEN",
  SIGNUP_CONFIRMATION_REQUIRED: "SIGNUP_CONFIRMATION_REQUIRED",
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
  BLOCKED_SENDER_NOT_FOUND: "BLOCKED_SENDER_NOT_FOUND",
  TOKEN_NOT_FOUND: "TOKEN_NOT_FOUND",

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
  SIGNUP_PROVIDER_NOT_ALLOWED: "SIGNUP_PROVIDER_NOT_ALLOWED",

  // Conflict errors (409)
  OAUTH_ALREADY_LINKED: "OAUTH_ALREADY_LINKED",
  CANNOT_UNLINK_ONLY_AUTH: "CANNOT_UNLINK_ONLY_AUTH",

  // Rate limiting (429)
  RATE_LIMITED: "RATE_LIMITED",

  // Server errors (500)
  INTERNAL_ERROR: "INTERNAL_ERROR",
  TOKEN_CREATION_FAILED: "TOKEN_CREATION_FAILED",
  FEED_FETCH_ERROR: "FEED_FETCH_ERROR",
  PARSE_ERROR: "PARSE_ERROR",
  SAVED_ARTICLE_FETCH_ERROR: "SAVED_ARTICLE_FETCH_ERROR",

  // Payload too large errors (413)
  CONTENT_TOO_LARGE: "CONTENT_TOO_LARGE",
  MAX_SUBSCRIPTIONS_REACHED: "MAX_SUBSCRIPTIONS_REACHED",

  // Bad gateway errors (502)
  SITE_BLOCKED: "SITE_BLOCKED",

  // Upstream rate limiting (429 from the target site, not from us)
  UPSTREAM_RATE_LIMITED: "UPSTREAM_RATE_LIMITED",
} as const;

type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

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
  | "BAD_GATEWAY"
> = {
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_CREDENTIALS: "UNAUTHORIZED",
  SESSION_EXPIRED: "UNAUTHORIZED",
  ADMIN_UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  SIGNUP_CONFIRMATION_REQUIRED: "FORBIDDEN",
  ADMIN_SECRET_NOT_CONFIGURED: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  USER_NOT_FOUND: "NOT_FOUND",
  FEED_NOT_FOUND: "NOT_FOUND",
  ENTRY_NOT_FOUND: "NOT_FOUND",
  SUBSCRIPTION_NOT_FOUND: "NOT_FOUND",
  TAG_NOT_FOUND: "NOT_FOUND",
  SAVED_ARTICLE_NOT_FOUND: "NOT_FOUND",
  INGEST_ADDRESS_NOT_FOUND: "NOT_FOUND",
  BLOCKED_SENDER_NOT_FOUND: "NOT_FOUND",
  TOKEN_NOT_FOUND: "NOT_FOUND",
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
  SIGNUP_PROVIDER_NOT_ALLOWED: "FORBIDDEN",
  OAUTH_ALREADY_LINKED: "CONFLICT",
  CANNOT_UNLINK_ONLY_AUTH: "BAD_REQUEST",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  INTERNAL_ERROR: "INTERNAL_SERVER_ERROR",
  TOKEN_CREATION_FAILED: "INTERNAL_SERVER_ERROR",
  FEED_FETCH_ERROR: "INTERNAL_SERVER_ERROR",
  PARSE_ERROR: "INTERNAL_SERVER_ERROR",
  // A failed fetch of a user-provided URL (404, DNS failure, connection reset,
  // …) is a client/input error, not a server bug — the user gave us a URL we
  // can't retrieve. Classify as 4xx so it isn't reported to Sentry (the timing
  // middleware only exempts client codes) and callers get a proper client error.
  SAVED_ARTICLE_FETCH_ERROR: "BAD_REQUEST",
  CONTENT_TOO_LARGE: "BAD_REQUEST",
  MAX_SUBSCRIPTIONS_REACHED: "BAD_REQUEST",
  SITE_BLOCKED: "BAD_GATEWAY",
  UPSTREAM_RATE_LIMITED: "TOO_MANY_REQUESTS",
};

/**
 * Creates a TRPCError with consistent formatting.
 *
 * @param code - The application error code
 * @param message - Human-readable error message
 * @param details - Optional additional context
 */
function createError(
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

  signupConfirmationRequired: () =>
    createError(
      ErrorCodes.SIGNUP_CONFIRMATION_REQUIRED,
      "You must complete signup before accessing this resource"
    ),

  notFound: (resource: string) => createError(ErrorCodes.NOT_FOUND, `${resource} not found`),

  userNotFound: () => createError(ErrorCodes.USER_NOT_FOUND, "User not found"),

  feedNotFound: () => createError(ErrorCodes.FEED_NOT_FOUND, "Feed not found"),

  entryNotFound: () => createError(ErrorCodes.ENTRY_NOT_FOUND, "Entry not found"),

  subscriptionNotFound: () =>
    createError(ErrorCodes.SUBSCRIPTION_NOT_FOUND, "Subscription not found"),

  tagNotFound: () => createError(ErrorCodes.TAG_NOT_FOUND, "Tag not found"),

  ingestAddressNotFound: () =>
    createError(ErrorCodes.INGEST_ADDRESS_NOT_FOUND, "Ingest address not found"),

  blockedSenderNotFound: () =>
    createError(ErrorCodes.BLOCKED_SENDER_NOT_FOUND, "Blocked sender not found"),

  tokenNotFound: () =>
    createError(ErrorCodes.TOKEN_NOT_FOUND, "Token not found or already revoked"),

  tokenCreationFailed: () =>
    createError(ErrorCodes.TOKEN_CREATION_FAILED, "Failed to retrieve created token"),

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

  siteBlocked: (url: string, status: number) =>
    createError(
      ErrorCodes.SITE_BLOCKED,
      "This website blocked the request. Some sites don't allow automated access.",
      {
        url,
        status,
      }
    ),

  upstreamRateLimited: (url: string) =>
    createError(
      ErrorCodes.UPSTREAM_RATE_LIMITED,
      "This website is temporarily rate limiting requests. Please try again later.",
      { url }
    ),

  // Signup provider restriction errors
  signupProviderNotAllowed: (provider: string) =>
    createError(
      ErrorCodes.SIGNUP_PROVIDER_NOT_ALLOWED,
      `Signup with ${provider} is not allowed on this server. Please use a different sign-in method.`
    ),

  // Invite errors
  inviteRequired: () =>
    createError(ErrorCodes.INVITE_REQUIRED, "An invite is required to register"),

  inviteInvalid: () => createError(ErrorCodes.INVITE_INVALID, "Invalid invite token"),

  inviteExpired: () => createError(ErrorCodes.INVITE_EXPIRED, "Invite token has expired"),

  inviteAlreadyUsed: () =>
    createError(ErrorCodes.INVITE_ALREADY_USED, "Invite token has already been used"),

  // Usage limit errors
  contentTooLarge: (resource: string, maxBytes: number) =>
    createError(
      ErrorCodes.CONTENT_TOO_LARGE,
      `${resource} exceeds the maximum size of ${Math.round(maxBytes / (1024 * 1024))}MB`,
      { maxBytes }
    ),

  maxSubscriptionsReached: (limit: number) =>
    createError(
      ErrorCodes.MAX_SUBSCRIPTIONS_REACHED,
      `You have reached the maximum number of subscriptions (${limit})`,
      { limit }
    ),

  // Admin errors
  adminSecretNotConfigured: () =>
    createError(
      ErrorCodes.ADMIN_SECRET_NOT_CONFIGURED,
      "Admin API is not configured on this server"
    ),

  adminUnauthorized: () => createError(ErrorCodes.ADMIN_UNAUTHORIZED, "Invalid admin secret"),
};

/**
 * Extracts our custom app error code (set by {@link createError} in the
 * TRPCError `cause`) from a thrown value, or `undefined` if it isn't one of ours.
 */
export function getAppErrorCode(error: unknown): string | undefined {
  if (!(error instanceof TRPCError)) return undefined;
  const cause = error.cause;
  return cause && typeof cause === "object" && "code" in cause
    ? (cause as { code: string }).code
    : undefined;
}

/**
 * App error codes that represent an **expected** condition — the user's input or
 * an upstream site, not a bug in our server — but which map to a 5xx HTTP status.
 * These should be treated like client errors for **reporting** purposes: e.g. a
 * target site blocking our fetch bot is a normal outcome of saving an arbitrary
 * URL, so it must not be reported to Sentry even though `SITE_BLOCKED` maps to
 * HTTP 502 (an honest status to return to the client).
 *
 * 4xx-mapped app codes (e.g. `SAVED_ARTICLE_FETCH_ERROR`, `UPSTREAM_RATE_LIMITED`,
 * `CONTENT_TOO_LARGE`) are already treated as client errors by their HTTP status
 * and don't need to be listed here.
 */
const EXPECTED_CLIENT_ERROR_CODES: ReadonlySet<string> = new Set([ErrorCodes.SITE_BLOCKED]);

/**
 * Whether a thrown error is an expected client/upstream condition that maps to a
 * 5xx status but should not be reported as a server bug. See
 * {@link EXPECTED_CLIENT_ERROR_CODES}.
 */
export function isExpectedClientError(error: unknown): boolean {
  const code = getAppErrorCode(error);
  return code !== undefined && EXPECTED_CLIENT_ERROR_CODES.has(code);
}
