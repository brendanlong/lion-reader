/**
 * tRPC Error Helpers
 *
 * Provides consistent error creation and handling across the API.
 * All errors follow the format: { error: { code, message, details? } }
 */

import { TRPCError } from "@trpc/server";

/**
 * Maps our application error codes to tRPC error codes (and thus HTTP statuses).
 */
const errorCodeToTRPCCode = {
  INVALID_CREDENTIALS: "UNAUTHORIZED",
  ADMIN_UNAUTHORIZED: "UNAUTHORIZED",
  SIGNUP_CONFIRMATION_REQUIRED: "FORBIDDEN",
  ADMIN_SECRET_NOT_CONFIGURED: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  ENTRY_NOT_FOUND: "NOT_FOUND",
  SUBSCRIPTION_NOT_FOUND: "NOT_FOUND",
  TAG_NOT_FOUND: "NOT_FOUND",
  SAVED_ARTICLE_NOT_FOUND: "NOT_FOUND",
  INGEST_ADDRESS_NOT_FOUND: "NOT_FOUND",
  BLOCKED_SENDER_NOT_FOUND: "NOT_FOUND",
  TOKEN_NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "BAD_REQUEST",
  URL_IS_FEED: "BAD_REQUEST",
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
  INTERNAL_ERROR: "INTERNAL_SERVER_ERROR",
  SESSION_REVOKE_FAILED: "INTERNAL_SERVER_ERROR",
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
  SERVER_BUSY: "TOO_MANY_REQUESTS",
  AI_PROVIDER_BUSY: "TOO_MANY_REQUESTS",
  // Only for a call made with the user's own key: their key, credit, or model
  // choice is the problem, not our server.
  AI_PROVIDER_REJECTED: "BAD_REQUEST",
  AI_PROVIDER_KEY_UNREADABLE: "BAD_REQUEST",
} as const satisfies Record<string, TRPCError["code"]>;

type ErrorCode = keyof typeof errorCodeToTRPCCode;

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
  invalidCredentials: () => createError("INVALID_CREDENTIALS", "Invalid email or password"),

  signupConfirmationRequired: () =>
    createError(
      "SIGNUP_CONFIRMATION_REQUIRED",
      "You must complete signup before accessing this resource"
    ),

  notFound: (resource: string) => createError("NOT_FOUND", `${resource} not found`),

  entryNotFound: () => createError("ENTRY_NOT_FOUND", "Entry not found"),

  subscriptionNotFound: () => createError("SUBSCRIPTION_NOT_FOUND", "Subscription not found"),

  tagNotFound: () => createError("TAG_NOT_FOUND", "Tag not found"),

  ingestAddressNotFound: () => createError("INGEST_ADDRESS_NOT_FOUND", "Ingest address not found"),

  blockedSenderNotFound: () => createError("BLOCKED_SENDER_NOT_FOUND", "Blocked sender not found"),

  tokenNotFound: () => createError("TOKEN_NOT_FOUND", "Token not found or already revoked"),

  tokenCreationFailed: () =>
    createError("TOKEN_CREATION_FAILED", "Failed to retrieve created token"),

  maxIngestAddressesReached: (limit: number) =>
    createError(
      "MAX_INGEST_ADDRESSES_REACHED",
      `Maximum number of ingest addresses (${limit}) reached`
    ),

  validation: (message: string, details?: Record<string, unknown>) =>
    createError("VALIDATION_ERROR", message, details),

  /**
   * The URL a caller tried to save is actually a feed, not an article. The
   * message is the machine-readable token `URL_IS_FEED` (tRPC does not ship the
   * `cause` to clients, so the web share/save UI matches on the message — same
   * pattern as the NEEDS_GOOGLE_* codes) so the PWA can route the user to the
   * Subscribe page instead of failing the save.
   */
  urlIsFeed: (url: string) => createError("URL_IS_FEED", "URL_IS_FEED", { url }),

  emailExists: () =>
    createError("EMAIL_ALREADY_EXISTS", "An account with this email already exists"),

  oauthStateInvalid: () =>
    createError(
      "OAUTH_STATE_INVALID",
      "Invalid or expired OAuth state. Please try signing in again."
    ),

  oauthProviderNotConfigured: (provider: string) =>
    createError(
      "OAUTH_PROVIDER_NOT_CONFIGURED",
      `${provider} OAuth is not configured on this server`
    ),

  oauthCallbackFailed: (reason: string) =>
    createError("OAUTH_CALLBACK_FAILED", `OAuth callback failed: ${reason}`),

  oauthAlreadyLinked: (provider: string) =>
    createError("OAUTH_ALREADY_LINKED", `A ${provider} account is already linked to your account`),

  cannotUnlinkOnlyAuth: () =>
    createError(
      "CANNOT_UNLINK_ONLY_AUTH",
      "Cannot unlink this account because it is your only authentication method. Add a password first."
    ),

  sessionRevokeFailed: (change: string) =>
    createError(
      "SESSION_REVOKE_FAILED",
      `${change}, but signing out your other devices failed. Review them under Settings → Sessions.`
    ),

  internal: (message = "An unexpected error occurred") => createError("INTERNAL_ERROR", message),

  serverBusy: (work: string) =>
    createError("SERVER_BUSY", `Too many ${work} in progress. Please try again shortly.`),

  aiProviderBusy: (provider: string) =>
    createError("AI_PROVIDER_BUSY", `${provider} is busy right now. Please try again shortly.`),

  aiProviderRejected: (provider: string, reason: string) =>
    createError("AI_PROVIDER_REJECTED", `${provider} rejected the request: ${reason}`),

  /** The user's saved key for the provider doesn't decrypt; they have to enter it again. */
  aiProviderKeyUnreadable: (message: string) => createError("AI_PROVIDER_KEY_UNREADABLE", message),

  feedFetchError: (url: string, reason: string) =>
    createError("FEED_FETCH_ERROR", `Failed to fetch feed: ${reason}`, {
      url,
    }),

  parseError: (reason: string) => createError("PARSE_ERROR", `Failed to parse feed: ${reason}`),

  savedArticleNotFound: () => createError("SAVED_ARTICLE_NOT_FOUND", "Saved article not found"),

  savedArticleFetchError: (url: string, reason: string) =>
    createError("SAVED_ARTICLE_FETCH_ERROR", `Failed to fetch page: ${reason}`, {
      url,
    }),

  siteBlocked: (url: string, status: number) =>
    createError(
      "SITE_BLOCKED",
      "This website blocked the request. Some sites don't allow automated access.",
      {
        url,
        status,
      }
    ),

  upstreamRateLimited: (url: string) =>
    createError(
      "UPSTREAM_RATE_LIMITED",
      "This website is temporarily rate limiting requests. Please try again later.",
      { url }
    ),

  // Signup provider restriction errors
  signupProviderNotAllowed: (provider: string) =>
    createError(
      "SIGNUP_PROVIDER_NOT_ALLOWED",
      `Signup with ${provider} is not allowed on this server. Please use a different sign-in method.`
    ),

  // Invite errors
  inviteRequired: () => createError("INVITE_REQUIRED", "An invite is required to register"),

  inviteInvalid: () => createError("INVITE_INVALID", "Invalid invite token"),

  inviteExpired: () => createError("INVITE_EXPIRED", "Invite token has expired"),

  inviteAlreadyUsed: () => createError("INVITE_ALREADY_USED", "Invite token has already been used"),

  // Usage limit errors
  contentTooLarge: (resource: string, maxBytes: number) =>
    createError(
      "CONTENT_TOO_LARGE",
      `${resource} exceeds the maximum size of ${Math.round(maxBytes / (1024 * 1024))}MB`,
      { maxBytes }
    ),

  /** For content within the byte limits that still costs too much to process. */
  contentTooComplex: (resource: string) =>
    createError("CONTENT_TOO_LARGE", `${resource} is too large or complex to process`),

  maxSubscriptionsReached: (limit: number) =>
    createError(
      "MAX_SUBSCRIPTIONS_REACHED",
      `You have reached the maximum number of subscriptions (${limit})`,
      { limit }
    ),

  // Admin errors
  adminSecretNotConfigured: () =>
    createError("ADMIN_SECRET_NOT_CONFIGURED", "Admin API is not configured on this server"),

  adminUnauthorized: () => createError("ADMIN_UNAUTHORIZED", "Invalid admin secret"),
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
 * App codes that map to a tRPC code the middleware already exempts (`BAD_REQUEST`,
 * `TOO_MANY_REQUESTS`, ... — see the list in `src/server/trpc/trpc.ts`) don't need
 * to be listed here.
 */
const EXPECTED_CLIENT_ERROR_CODES: ReadonlySet<string> = new Set(["SITE_BLOCKED"]);

/**
 * Whether a thrown error is an expected client/upstream condition that maps to a
 * 5xx status but should not be reported as a server bug. See
 * {@link EXPECTED_CLIENT_ERROR_CODES}.
 */
export function isExpectedClientError(error: unknown): boolean {
  const code = getAppErrorCode(error);
  return code !== undefined && EXPECTED_CLIENT_ERROR_CODES.has(code);
}
