/**
 * Environment Configuration
 *
 * Centralized access to environment variables with type safety.
 */

/**
 * Valid signup provider types.
 * - "email": Email/password signup
 * - "google", "apple", "discord": OAuth providers
 */
export const ALL_SIGNUP_PROVIDERS = ["email", "google", "apple", "discord"] as const;
export type SignupProvider = (typeof ALL_SIGNUP_PROVIDERS)[number];

/**
 * Parse ALLOWED_SIGNUP_PROVIDERS env var into a list of allowed providers.
 * Format: comma-separated list, e.g. "apple,google,email"
 * Default: all providers allowed (when env var is not set)
 */
function parseAllowedSignupProviders(): readonly SignupProvider[] {
  const raw = process.env.ALLOWED_SIGNUP_PROVIDERS;
  if (!raw) return ALL_SIGNUP_PROVIDERS;

  const providers = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is SignupProvider => ALL_SIGNUP_PROVIDERS.includes(s as SignupProvider));

  return providers.length > 0 ? providers : ALL_SIGNUP_PROVIDERS;
}

/**
 * Signup configuration.
 * ALLOW_ALL_SIGNUPS=true bypasses invite requirement.
 * ALLOWLIST_SECRET protects admin endpoints for managing invites.
 * ALLOWED_SIGNUP_PROVIDERS limits which providers can be used for new signups.
 */
export const signupConfig = {
  /** If true, anyone can sign up without an invite. Defaults to false. */
  allowAllSignups: process.env.ALLOW_ALL_SIGNUPS === "true",

  /** Secret for admin API endpoints. If not set, admin endpoints are disabled. */
  allowlistSecret: process.env.ADMIN_SECRET ?? process.env.ALLOWLIST_SECRET,

  /**
   * List of providers allowed for new signups.
   * Parsed from ALLOWED_SIGNUP_PROVIDERS env var (comma-separated).
   * Default: all providers allowed.
   * Stacks with invite requirement (both must be satisfied).
   */
  allowedSignupProviders: parseAllowedSignupProviders(),
};

/**
 * Feed fetcher configuration.
 * These values are included in the User-Agent header for feed requests.
 */
export const fetcherConfig = {
  /** Optional contact email to include in User-Agent header. */
  contactEmail: process.env.FETCHER_CONTACT_EMAIL,
  /** App URL to include in User-Agent header (uses NEXT_PUBLIC_APP_URL). */
  appUrl: process.env.NEXT_PUBLIC_APP_URL,
  /** Git commit SHA, injected at build time via next.config.ts. */
  commitSha: process.env.GIT_COMMIT_SHA,
};

/**
 * Email ingest configuration.
 * INGEST_EMAIL_DOMAIN is the domain for ingest email addresses.
 * MAILGUN_WEBHOOK_SIGNING_KEY is the signing key for authenticating Mailgun webhook requests.
 */
export const ingestConfig = {
  /** Domain for ingest email addresses. Email format: {token}@{domain} */
  emailDomain: process.env.INGEST_EMAIL_DOMAIN || "ingest.lionreader.com",

  /**
   * Mailgun webhook signing key for HMAC signature verification.
   * Find this in Mailgun dashboard: Sending -> Webhooks -> Webhook signing key.
   * Must be set for email webhooks to work.
   */
  mailgunWebhookSigningKey: process.env.MAILGUN_WEBHOOK_SIGNING_KEY,
};

/**
 * Google API configuration.
 * Service account credentials are used for accessing Google APIs (like Docs API).
 * This is separate from OAuth credentials which are used for user authentication.
 */
export const googleConfig = {
  /**
   * Google Service Account credentials for accessing public Google Docs.
   * The Google Docs API requires OAuth2 tokens (not API keys), so we use a
   * service account to get tokens for server-side access to public documents.
   *
   * Setup:
   * 1. Create a service account at: https://console.cloud.google.com/iam-admin/serviceaccounts
   * 2. Create a JSON key for the service account
   * 3. Enable "Google Docs API" for the project
   * 4. Base64 encode the JSON: cat service-account.json | base64 -w 0
   * 5. Set as GOOGLE_SERVICE_ACCOUNT_JSON environment variable
   *
   * If not set, Google Docs URLs will fall back to HTML scraping.
   */
  serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
};

/**
 * Object Storage Configuration (S3-compatible)
 *
 * Used for storing uploaded images from Google Docs and other sources.
 * Compatible with AWS S3, Fly.io Tigris, and other S3-compatible services.
 *
 * For Fly.io Tigris:
 * 1. Create a bucket: fly storage create
 * 2. The bucket name will be set automatically
 * 3. Set STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY from the output
 * 4. Endpoint will default to Tigris: https://fly.storage.tigris.dev
 *
 * For AWS S3:
 * 1. Create an S3 bucket
 * 2. Create IAM credentials with S3 access
 * 3. Set STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY
 * 4. Set STORAGE_ENDPOINT to your S3 region endpoint (optional for AWS)
 */
/**
 * GitHub API configuration.
 * Optional token improves rate limits from 60/hour to 5,000/hour.
 */
export const githubConfig = {
  /**
   * GitHub API token for improved rate limits (optional).
   *
   * Without token: 60 requests/hour
   * With token: 5,000 requests/hour
   *
   * Create a fine-grained token at: https://github.com/settings/tokens?type=beta
   * No permissions/scopes needed for public repos and gists.
   *
   * If not set, the GitHub plugin will still work but with lower rate limits.
   */
  apiToken: process.env.GITHUB_API_TOKEN,
};

/**
 * Usage limits configuration.
 * These limits protect against abuse and prevent OOM from oversized content.
 * All limits are configurable via environment variables.
 */
export const usageLimitsConfig = {
  /** Maximum number of active subscriptions per user (default: 500). */
  maxSubscriptionsPerUser: parseInt(process.env.MAX_SUBSCRIPTIONS_PER_USER || "500", 10),

  /** Maximum feed response size in bytes (default: 10MB). Checked during streaming to avoid OOM. */
  maxFeedSizeBytes: parseInt(process.env.MAX_FEED_SIZE_BYTES || String(10 * 1024 * 1024), 10),

  /** Maximum number of entries to parse from a single feed (default: 100). */
  maxFeedEntries: parseInt(process.env.MAX_FEED_ENTRIES || "100", 10),

  /** Maximum saved article page size in bytes (default: 5MB). */
  maxSavedArticleSizeBytes: parseInt(
    process.env.MAX_SAVED_ARTICLE_SIZE_BYTES || String(5 * 1024 * 1024),
    10
  ),

  /** Maximum email content size in bytes (default: 2MB). Emails larger than this are rejected. */
  maxEmailSizeBytes: parseInt(process.env.MAX_EMAIL_SIZE_BYTES || String(2 * 1024 * 1024), 10),
};

export const storageConfig = {
  /** S3 bucket name for storing images */
  bucket: process.env.STORAGE_BUCKET,

  /** AWS access key ID or Tigris access key */
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,

  /** AWS secret access key or Tigris secret key */
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,

  /**
   * S3-compatible endpoint URL.
   * For Tigris: https://fly.storage.tigris.dev
   * For AWS S3: leave empty or use regional endpoint
   */
  endpoint: process.env.STORAGE_ENDPOINT,

  /** AWS region (default: auto for Tigris) */
  region: process.env.STORAGE_REGION || "auto",

  /**
   * Public URL base for accessing stored objects.
   * For Tigris: https://{bucket}.fly.storage.tigris.dev
   * For AWS S3: https://{bucket}.s3.{region}.amazonaws.com
   * If not set, uses the default bucket URL pattern.
   */
  publicUrlBase: process.env.STORAGE_PUBLIC_URL_BASE,
};
