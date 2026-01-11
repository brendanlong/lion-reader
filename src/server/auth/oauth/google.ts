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

/**
 * Google Docs readonly scope (for incremental authorization)
 */
export const GOOGLE_DOCS_READONLY_SCOPE = "https://www.googleapis.com/auth/documents.readonly";

// ============================================================================
// Types
// ============================================================================

/**
 * Response from Google's userinfo endpoint
 */
interface GoogleUserInfo {
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
  /** OAuth scopes that were granted */
  scopes: string[];
  /** OAuth flow mode */
  mode: OAuthMode;
  /** Optional return URL for extension-save mode */
  returnUrl?: string;
  /** Optional invite token for new user registration */
  inviteToken?: string;
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
 * OAuth flow mode - determines redirect behavior after callback
 */
export type OAuthMode = "login" | "link" | "save" | "extension-save";

/**
 * Data stored in Redis for PKCE verification
 */
interface PkceData {
  verifier: string;
  scopes: string[];
  mode: OAuthMode;
  /** Optional return URL for modes that need to redirect back to a specific page */
  returnUrl?: string;
  /** Optional invite token for new user registration */
  inviteToken?: string;
}

/**
 * Stores a PKCE code verifier, scopes, and mode in Redis
 * The verifier is associated with the state parameter
 *
 * @param state - The OAuth state parameter
 * @param codeVerifier - The PKCE code verifier
 * @param scopes - The OAuth scopes being requested
 * @param mode - The OAuth flow mode (login, link, save, or extension-save)
 * @param returnUrl - Optional return URL for extension-save mode
 * @param inviteToken - Optional invite token for new user registration
 */
async function storePkceVerifier(
  state: string,
  codeVerifier: string,
  scopes: string[],
  mode: OAuthMode,
  returnUrl?: string,
  inviteToken?: string
): Promise<void> {
  const key = getPkceKey(state);
  const data: PkceData = { verifier: codeVerifier, scopes, mode, returnUrl, inviteToken };
  await redis.setex(key, PKCE_VERIFIER_TTL_SECONDS, JSON.stringify(data));
}

/**
 * Retrieves and deletes PKCE data from Redis
 * This ensures one-time use of the verifier
 *
 * @param state - The OAuth state parameter
 * @returns The PKCE data (verifier + scopes), or null if not found/expired
 */
async function consumePkceVerifier(state: string): Promise<PkceData | null> {
  const key = getPkceKey(state);

  // Get and delete in a single transaction to ensure one-time use
  const dataStr = await redis.get(key);

  if (dataStr) {
    await redis.del(key);
    try {
      return JSON.parse(dataStr) as PkceData;
    } catch {
      return null;
    }
  }

  return null;
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
 * @param additionalScopes - Optional additional scopes to request (for incremental auth)
 * @param mode - The OAuth flow mode (defaults to "login")
 * @param returnUrl - Optional return URL for extension-save mode
 * @param inviteToken - Optional invite token for new user registration
 * @returns The authorization URL and state
 * @throws Error if Google OAuth is not configured
 */
export async function createGoogleAuthUrl(
  additionalScopes?: string[],
  mode: OAuthMode = "login",
  returnUrl?: string,
  inviteToken?: string
): Promise<GoogleAuthUrlResult> {
  const google = getGoogleProvider();

  if (!google) {
    throw new Error("Google OAuth is not configured");
  }

  // Generate PKCE and state parameters
  const state = generateState();
  const codeVerifier = generateCodeVerifier();

  // Combine base scopes with additional scopes (if any)
  const scopes = additionalScopes
    ? [...GOOGLE_SCOPES, ...additionalScopes.filter((s) => !GOOGLE_SCOPES.includes(s))]
    : GOOGLE_SCOPES;

  // Store the code verifier, scopes, mode, return URL, and invite token for later use
  await storePkceVerifier(state, codeVerifier, scopes, mode, returnUrl, inviteToken);

  // Create the authorization URL
  const url = google.createAuthorizationURL(state, codeVerifier, scopes);

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

  // Retrieve and consume the PKCE data (verifier + scopes)
  const pkceData = await consumePkceVerifier(state);

  if (!pkceData) {
    throw new Error("Invalid or expired OAuth state");
  }

  // Exchange the authorization code for tokens
  const tokens = await google.validateAuthorizationCode(code, pkceData.verifier);

  // Fetch user info from Google
  const userInfo = await fetchGoogleUserInfo(tokens.accessToken());

  return {
    userInfo,
    tokens: {
      accessToken: tokens.accessToken(),
      refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined,
      expiresAt: tokens.accessTokenExpiresAt(),
    },
    scopes: pkceData.scopes,
    mode: pkceData.mode,
    returnUrl: pkceData.returnUrl,
    inviteToken: pkceData.inviteToken,
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
