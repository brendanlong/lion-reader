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
