/**
 * Apple OAuth Flow Implementation
 *
 * This module handles the Apple OAuth flow including:
 * - Generating authorization URLs
 * - Storing/retrieving state in Redis
 * - Exchanging authorization codes for tokens
 * - Decoding Apple's JWT id_token for user info
 *
 * Important Apple-specific considerations:
 * - Apple only sends user info (name, email) on FIRST authorization
 * - Users may use Apple's private relay email (randomized@privaterelay.appleid.com)
 * - Apple uses JWT id_token to convey user information
 * - Apple requires response_mode=form_post for the callback
 */

import { generateState } from "arctic";
import { getAppleProvider, isProviderEnabled } from "./config";
import { redis } from "@/server/redis";

// ============================================================================
// Constants
// ============================================================================

/**
 * State storage TTL (10 minutes)
 * Users should complete the OAuth flow within this time
 */
const STATE_TTL_SECONDS = 600;

/**
 * Redis key prefix for OAuth state
 */
const STATE_PREFIX = "oauth:apple:state:";

/**
 * Apple OAuth scopes
 * - name: Get user's name (only sent on first auth)
 * - email: Get user's email (only sent on first auth)
 */
const APPLE_SCOPES = ["name", "email"];

// ============================================================================
// Types
// ============================================================================

/**
 * User information from Apple's id_token JWT
 * Note: Apple encodes user info in the JWT, not a separate userinfo endpoint
 */
export interface AppleUserInfo {
  /** Apple's unique user ID (subject) - always present in id_token */
  sub: string;
  /** User's email address - may be a private relay address */
  email?: string;
  /** Whether the email is a private relay email */
  isPrivateEmail?: boolean;
  /** Whether the email has been verified by Apple */
  emailVerified?: boolean;
}

/**
 * User data sent by Apple on first authorization only
 * This comes as a separate parameter in the callback, not in the JWT
 */
export interface AppleFirstAuthUserData {
  /** User's name (only on first auth) */
  name?: {
    firstName?: string;
    lastName?: string;
  };
  /** User's email (also in JWT, but may include more details here) */
  email?: string;
}

/**
 * Result of generating an authorization URL
 */
export interface AppleAuthUrlResult {
  /** The authorization URL to redirect the user to */
  url: string;
  /** The state parameter for CSRF protection */
  state: string;
}

/**
 * Result of validating an Apple OAuth callback
 */
export interface AppleAuthResult {
  /** Apple user information from JWT */
  userInfo: AppleUserInfo;
  /** User data from first auth (name, email) - only present on first authorization */
  firstAuthData?: AppleFirstAuthUserData;
  /** OAuth tokens */
  tokens: {
    accessToken: string;
    refreshToken?: string;
    idToken: string;
    expiresAt?: Date;
  };
}

/**
 * Decoded Apple JWT id_token payload
 */
interface AppleJWTPayload {
  iss: string; // https://appleid.apple.com
  aud: string; // client_id
  exp: number; // expiration timestamp
  iat: number; // issued at timestamp
  sub: string; // user's unique ID
  email?: string;
  email_verified?: string | boolean;
  is_private_email?: string | boolean;
  auth_time: number;
  nonce_supported: boolean;
}

// ============================================================================
// State Storage
// ============================================================================

/**
 * Gets the Redis key for an OAuth state
 */
function getStateKey(state: string): string {
  return `${STATE_PREFIX}${state}`;
}

/**
 * Stores the OAuth state in Redis
 * The state is used for CSRF protection
 *
 * @param state - The OAuth state parameter
 */
async function storeState(state: string): Promise<void> {
  const key = getStateKey(state);
  await redis.setex(key, STATE_TTL_SECONDS, "valid");
}

/**
 * Validates and consumes an OAuth state from Redis
 * This ensures one-time use of the state
 *
 * @param state - The OAuth state parameter
 * @returns Whether the state was valid
 */
async function consumeState(state: string): Promise<boolean> {
  const key = getStateKey(state);

  // Get and delete in a single check
  const value = await redis.get(key);

  if (value) {
    await redis.del(key);
    return true;
  }

  return false;
}

// ============================================================================
// JWT Decoding
// ============================================================================

/**
 * Decodes an Apple JWT id_token to extract user information
 * Note: We don't verify the signature here as arctic already validates the tokens
 *
 * @param idToken - The JWT id_token from Apple
 * @returns The decoded payload
 */
function decodeAppleIdToken(idToken: string): AppleJWTPayload {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid id_token format");
  }

  // Decode the payload (second part)
  const payload = parts[1];
  const decoded = Buffer.from(payload, "base64url").toString("utf8");

  return JSON.parse(decoded) as AppleJWTPayload;
}

/**
 * Extracts user info from Apple's id_token
 *
 * @param idToken - The JWT id_token from Apple
 * @returns Parsed user information
 */
function extractUserInfoFromToken(idToken: string): AppleUserInfo {
  const payload = decodeAppleIdToken(idToken);

  // Parse email_verified - Apple may send as string "true"/"false" or boolean
  let emailVerified: boolean | undefined;
  if (payload.email_verified !== undefined) {
    emailVerified = payload.email_verified === true || payload.email_verified === "true";
  }

  // Parse is_private_email
  let isPrivateEmail: boolean | undefined;
  if (payload.is_private_email !== undefined) {
    isPrivateEmail = payload.is_private_email === true || payload.is_private_email === "true";
  }

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified,
    isPrivateEmail,
  };
}

// ============================================================================
// Apple OAuth Functions
// ============================================================================

/**
 * Generates an Apple OAuth authorization URL
 *
 * This creates:
 * 1. A random state parameter for CSRF protection (stored in Redis)
 * 2. The authorization URL with all parameters
 *
 * Note: Apple doesn't use PKCE like Google does
 *
 * @returns The authorization URL and state
 * @throws Error if Apple OAuth is not configured
 */
export async function createAppleAuthUrl(): Promise<AppleAuthUrlResult> {
  const apple = getAppleProvider();

  if (!apple) {
    throw new Error("Apple OAuth is not configured");
  }

  // Generate state parameter for CSRF protection
  const state = generateState();

  // Store the state for later verification
  await storeState(state);

  // Create the authorization URL
  const url = apple.createAuthorizationURL(state, APPLE_SCOPES);

  return {
    url: url.toString(),
    state,
  };
}

/**
 * Validates an Apple OAuth callback and retrieves user information
 *
 * This:
 * 1. Validates the state parameter
 * 2. Exchanges the authorization code for tokens
 * 3. Decodes the id_token to get user info
 * 4. Parses first-auth user data if present
 *
 * @param code - The authorization code from Apple
 * @param state - The state parameter for verification
 * @param userData - Optional user data (only sent on first authorization)
 * @returns The user info and tokens
 * @throws Error if Apple OAuth is not configured, state is invalid, or code exchange fails
 */
export async function validateAppleCallback(
  code: string,
  state: string,
  userData?: string | AppleFirstAuthUserData
): Promise<AppleAuthResult> {
  const apple = getAppleProvider();

  if (!apple) {
    throw new Error("Apple OAuth is not configured");
  }

  // Validate the state
  const isValidState = await consumeState(state);

  if (!isValidState) {
    throw new Error("Invalid or expired OAuth state");
  }

  // Exchange the authorization code for tokens
  const tokens = await apple.validateAuthorizationCode(code);

  // Apple returns an id_token that contains user info
  const idToken = tokens.idToken();

  // Extract user info from the id_token
  const userInfo = extractUserInfoFromToken(idToken);

  // Parse first-auth user data if provided
  // Apple sends this as a JSON string in the callback on first authorization only
  let firstAuthData: AppleFirstAuthUserData | undefined;
  if (userData) {
    if (typeof userData === "string") {
      try {
        firstAuthData = JSON.parse(userData) as AppleFirstAuthUserData;
      } catch {
        // If parsing fails, it's not valid JSON - ignore
      }
    } else {
      firstAuthData = userData;
    }
  }

  return {
    userInfo,
    firstAuthData,
    tokens: {
      accessToken: tokens.accessToken(),
      refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined,
      idToken,
      expiresAt: tokens.accessTokenExpiresAt(),
    },
  };
}

/**
 * Checks if Apple OAuth is available
 *
 * @returns Whether Apple OAuth is configured and enabled
 */
export function isAppleOAuthEnabled(): boolean {
  return isProviderEnabled("apple");
}

/**
 * Checks if an email is an Apple private relay email
 *
 * @param email - The email to check
 * @returns Whether the email is a private relay address
 */
export function isApplePrivateRelayEmail(email: string): boolean {
  return email.endsWith("@privaterelay.appleid.com");
}
