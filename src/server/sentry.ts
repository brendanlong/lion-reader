/**
 * Shared server-side Sentry initialization.
 *
 * Used by every server-side process:
 * - Next.js app server: via sentry.server.config.ts / sentry.edge.config.ts,
 *   loaded from src/instrumentation.ts
 * - Background worker: scripts/worker.ts
 * - Discord bot: scripts/discord-bot.ts
 *
 * The worker and bot must call this themselves — Next.js instrumentation only
 * runs in the app server, so without an explicit init their
 * `Sentry.captureException` calls are silent no-ops.
 */

import * as Sentry from "@sentry/nextjs";
import type { ErrorEvent } from "@sentry/nextjs";

// Query params whose values are credentials/PII and must never reach Sentry.
// Some clients pass these in the URL even on a POST — notably FeedMe sends the
// Google Reader `Passwd` (and `Email`) on the ClientLogin URL — so any captured
// request data would otherwise carry a plaintext password. Matched
// case-insensitively to cover `Passwd` (Google Reader) and
// `password`/`client_secret` (OAuth).
const SENSITIVE_QUERY_PARAMS = ["passwd", "password", "email", "client_secret"];

// The Google Reader write/session token is passed as `T` in the URL by some
// clients — worth redacting. Matched CASE-SENSITIVELY (uppercase only) so it
// does not also clobber the lowercase `t=` param, which this API uses for
// non-secret tag names (disable-tag) and feed titles (subscription/edit); those
// stay visible in Sentry for debugging.
const SENSITIVE_TOKEN_PARAM = "T";

/**
 * Redacts sensitive values from an event's captured request URL and query
 * string, in place. Preserves the parameter name so the shape is still visible.
 */
export function redactSensitiveRequestParams(event: ErrorEvent): void {
  const request = event.request;
  if (!request) return;

  // Boundary `(?:^|[?&])` requires the name to start the param, so `email` does
  // not match `…&someemail=` and `T` does not match `&nt=`/`&xt=`/etc.
  const ciPattern = new RegExp(`((?:^|[?&])(?:${SENSITIVE_QUERY_PARAMS.join("|")})=)[^&#]*`, "gi");
  const tokenPattern = new RegExp(`((?:^|[?&])${SENSITIVE_TOKEN_PARAM}=)[^&#]*`, "g");

  const redact = (value: string): string =>
    value.replace(ciPattern, "$1[REDACTED]").replace(tokenPattern, "$1[REDACTED]");

  if (typeof request.url === "string") {
    request.url = redact(request.url);
  }
  if (typeof request.query_string === "string") {
    request.query_string = redact(request.query_string);
  }
}

/**
 * Initializes Sentry if SENTRY_DSN is set. Safe to call more than once
 * (subsequent calls re-init the same client) and a no-op without a DSN.
 */
export function initSentry(): void {
  if (!process.env.SENTRY_DSN) {
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,

    // Adjust this value in production, or use tracesSampler for greater control
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,

    // Environment tag for filtering
    environment: process.env.NODE_ENV,

    // Only send errors from production
    enabled: process.env.NODE_ENV === "production",

    // Configure which errors to ignore
    beforeSend(event, hint) {
      const error = hint.originalException;

      // Don't report 4xx client errors (these are expected)
      if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();
        if (
          errorMessage.includes("unauthorized") ||
          errorMessage.includes("not found") ||
          errorMessage.includes("bad request") ||
          errorMessage.includes("forbidden")
        ) {
          return null;
        }
      }

      // Strip credentials some clients pass in the URL (e.g. FeedMe's Google
      // Reader `Passwd`) so plaintext passwords never reach Sentry.
      redactSensitiveRequestParams(event);

      return event;
    },

    // Ignore common expected errors
    ignoreErrors: [
      // Connection errors during health checks
      "ECONNREFUSED",
      // Redis connection errors during shutdown
      "Connection is closed",
    ],
  });
}
