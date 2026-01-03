/**
 * Environment Configuration
 *
 * Centralized access to environment variables with type safety.
 */

/**
 * Signup configuration.
 * ALLOW_ALL_SIGNUPS=true bypasses invite requirement.
 * ALLOWLIST_SECRET protects admin endpoints for managing invites.
 */
export const signupConfig = {
  /** If true, anyone can sign up without an invite. Defaults to false. */
  allowAllSignups: process.env.ALLOW_ALL_SIGNUPS === "true",

  /** Secret for admin API endpoints. If not set, admin endpoints are disabled. */
  allowlistSecret: process.env.ALLOWLIST_SECRET,
};

/**
 * Feed fetcher configuration.
 * FETCHER_CONTACT_EMAIL is an optional contact email included in the User-Agent header.
 */
export const fetcherConfig = {
  /** Optional contact email to include in User-Agent header for feed requests. */
  contactEmail: process.env.FETCHER_CONTACT_EMAIL,
};

/**
 * Email ingest configuration.
 * INGEST_EMAIL_DOMAIN is the domain for ingest email addresses.
 * EMAIL_WEBHOOK_SECRET is the shared secret for authenticating email webhook requests.
 */
export const ingestConfig = {
  /** Domain for ingest email addresses. Email format: {token}@{domain} */
  emailDomain: process.env.INGEST_EMAIL_DOMAIN || "ingest.lionreader.com",

  /** Shared secret for email webhook authentication. Must be set for webhooks to work. */
  webhookSecret: process.env.EMAIL_WEBHOOK_SECRET,
};
