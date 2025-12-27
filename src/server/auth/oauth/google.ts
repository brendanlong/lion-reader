/**
 * Google OAuth Flow Implementation
 *
 * This module handles the Google OAuth flow including:
 * - Generating authorization URLs with PKCE
 * - Storing/retrieving PKCE verifiers in Redis
 * - Exchanging authorization codes for tokens
 * - Fetching user info from Google
 */

import { generateCodeVerifier, generateState } from "arctic";
import { getGoogleProvider, isProviderEnabled } from "./config";
import { redis } from "@/server/redis";

// ============================================================================
// Constants
// ============================================================================

/**
 * PKCE verifier storage TTL (10 minutes)
 * Users should complete the OAuth flow within this time
 */
const PKCE_VERIFIER_TTL_SECONDS = 600;

/**
 * Redis key prefix for PKCE verifiers
 */
const PKCE_VERIFIER_PREFIX = "oauth:pkce:";

/**
 * Google OAuth scopes for authentication
 * - openid: Required for ID token
 * - email: Get user's email address
 * - profile: Get user's name and profile picture
 */
const GOOGLE_SCOPES = ["openid", "email", "profile"];

// ============================================================================
// Types
// ============================================================================

/**
 * Response from Google's userinfo endpoint
 */
export interface GoogleUserInfo {
  /** Google's unique user ID (subject) */
  sub: string;
  /** User's email address */
  email: string;
  /** Whether the email has been verified */
  email_verified: boolean;
  /** User's full name */
  name?: string;
  /** User's given name (first name) */
  given_name?: string;
  /** User's family name (last name) */
  family_name?: string;
  /** URL to user's profile picture */
  picture?: string;
}

/**
 * Result of generating an authorization URL
 */
export interface GoogleAuthUrlResult {
  /** The authorization URL to redirect the user to */
  url: string;
  /** The state parameter for CSRF protection */
  state: string;
}

/**
 * Result of validating a Google OAuth callback
 */
export interface GoogleAuthResult {
  /** Google user information */
  userInfo: GoogleUserInfo;
  /** OAuth tokens */
  tokens: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  };
}

// ============================================================================
// PKCE Verifier Storage
// ============================================================================

/**
 * Gets the Redis key for a PKCE verifier by state
 */
function getPkceKey(state: string): string {
  return `${PKCE_VERIFIER_PREFIX}${state}`;
}

/**
 * Stores a PKCE code verifier in Redis
 * The verifier is associated with the state parameter
 *
 * @param state - The OAuth state parameter
 * @param codeVerifier - The PKCE code verifier
 */
async function storePkceVerifier(state: string, codeVerifier: string): Promise<void> {
  const key = getPkceKey(state);
  await redis.setex(key, PKCE_VERIFIER_TTL_SECONDS, codeVerifier);
}

/**
 * Retrieves and deletes a PKCE code verifier from Redis
 * This ensures one-time use of the verifier
 *
 * @param state - The OAuth state parameter
 * @returns The code verifier, or null if not found/expired
 */
async function consumePkceVerifier(state: string): Promise<string | null> {
  const key = getPkceKey(state);

  // Get and delete in a single transaction to ensure one-time use
  const verifier = await redis.get(key);

  if (verifier) {
    await redis.del(key);
  }

  return verifier;
}

// ============================================================================
// Google OAuth Functions
// ============================================================================

/**
 * Generates a Google OAuth authorization URL with PKCE
 *
 * This creates:
 * 1. A random state parameter for CSRF protection
 * 2. A PKCE code verifier (stored in Redis)
 * 3. The authorization URL with all parameters
 *
 * @returns The authorization URL and state
 * @throws Error if Google OAuth is not configured
 */
export async function createGoogleAuthUrl(): Promise<GoogleAuthUrlResult> {
  const google = getGoogleProvider();

  if (!google) {
    throw new Error("Google OAuth is not configured");
  }

  // Generate PKCE and state parameters
  const state = generateState();
  const codeVerifier = generateCodeVerifier();

  // Store the code verifier for later use
  await storePkceVerifier(state, codeVerifier);

  // Create the authorization URL
  const url = google.createAuthorizationURL(state, codeVerifier, GOOGLE_SCOPES);

  return {
    url: url.toString(),
    state,
  };
}

/**
 * Validates a Google OAuth callback and retrieves user information
 *
 * This:
 * 1. Retrieves the PKCE verifier from Redis
 * 2. Exchanges the authorization code for tokens
 * 3. Fetches the user's Google profile
 *
 * @param code - The authorization code from Google
 * @param state - The state parameter for verification
 * @returns The user info and tokens
 * @throws Error if Google OAuth is not configured, state is invalid, or code exchange fails
 */
export async function validateGoogleCallback(
  code: string,
  state: string
): Promise<GoogleAuthResult> {
  const google = getGoogleProvider();

  if (!google) {
    throw new Error("Google OAuth is not configured");
  }

  // Retrieve and consume the PKCE verifier
  const codeVerifier = await consumePkceVerifier(state);

  if (!codeVerifier) {
    throw new Error("Invalid or expired OAuth state");
  }

  // Exchange the authorization code for tokens
  const tokens = await google.validateAuthorizationCode(code, codeVerifier);

  // Fetch user info from Google
  const userInfo = await fetchGoogleUserInfo(tokens.accessToken());

  return {
    userInfo,
    tokens: {
      accessToken: tokens.accessToken(),
      refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined,
      expiresAt: tokens.accessTokenExpiresAt(),
    },
  };
}

/**
 * Fetches user information from Google's userinfo endpoint
 *
 * @param accessToken - The OAuth access token
 * @returns The user's Google profile
 * @throws Error if the request fails
 */
async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch Google user info: ${error}`);
  }

  const userInfo = (await response.json()) as GoogleUserInfo;

  // Validate required fields
  if (!userInfo.sub || !userInfo.email) {
    throw new Error("Google user info is missing required fields");
  }

  return userInfo;
}

/**
 * Checks if Google OAuth is available
 *
 * @returns Whether Google OAuth is configured and enabled
 */
export function isGoogleOAuthEnabled(): boolean {
  return isProviderEnabled("google");
}
