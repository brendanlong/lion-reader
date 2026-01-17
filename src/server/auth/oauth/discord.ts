/**
 * Discord OAuth Flow Implementation
 *
 * This module handles the Discord OAuth flow including:
 * - Generating authorization URLs with state
 * - Storing/retrieving state in Redis
 * - Exchanging authorization codes for tokens
 * - Fetching user info from Discord
 */

import { generateState } from "arctic";
import { getDiscordProvider, isProviderEnabled } from "./config";
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
const STATE_PREFIX = "oauth:discord:";

/**
 * Discord OAuth scopes for authentication
 * - identify: Required to get user's ID and username
 * - email: Get user's email address
 */
const DISCORD_SCOPES = ["identify", "email"];

// ============================================================================
// Types
// ============================================================================

/**
 * Response from Discord's /users/@me endpoint
 */
interface DiscordUserInfo {
  /** Discord's unique user ID */
  id: string;
  /** User's username */
  username: string;
  /** User's email address (requires email scope) */
  email: string;
  /** Whether the email has been verified */
  verified: boolean;
  /** User's avatar hash */
  avatar?: string;
  /** User's global display name */
  global_name?: string;
}

/**
 * Result of generating an authorization URL
 */
export interface DiscordAuthUrlResult {
  /** The authorization URL to redirect the user to */
  url: string;
  /** The state parameter for CSRF protection */
  state: string;
}

/**
 * Result of validating a Discord OAuth callback
 */
export interface DiscordAuthResult {
  /** Discord user information */
  userInfo: DiscordUserInfo;
  /** OAuth tokens */
  tokens: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  };
  /** Optional invite token for new user registration */
  inviteToken?: string;
}

// ============================================================================
// State Storage
// ============================================================================

/**
 * Gets the Redis key for state by value
 */
function getStateKey(state: string): string {
  return `${STATE_PREFIX}${state}`;
}

/**
 * Data stored in Redis for state verification
 */
interface StateData {
  /** Optional invite token for new user registration */
  inviteToken?: string;
}

/**
 * Stores state data in Redis
 *
 * @param state - The OAuth state parameter
 * @param inviteToken - Optional invite token for new user registration
 */
async function storeState(state: string, inviteToken?: string): Promise<void> {
  const key = getStateKey(state);
  const data: StateData = { inviteToken };
  await redis.setex(key, STATE_TTL_SECONDS, JSON.stringify(data));
}

/**
 * Retrieves and deletes state data from Redis
 * This ensures one-time use of the state
 *
 * @param state - The OAuth state parameter
 * @returns The state data, or null if not found/expired
 */
async function consumeState(state: string): Promise<StateData | null> {
  const key = getStateKey(state);

  // Get and delete in a single transaction to ensure one-time use
  const dataStr = await redis.get(key);

  if (dataStr) {
    await redis.del(key);
    try {
      return JSON.parse(dataStr) as StateData;
    } catch {
      return null;
    }
  }

  return null;
}

// ============================================================================
// Discord OAuth Functions
// ============================================================================

/**
 * Generates a Discord OAuth authorization URL
 *
 * This creates:
 * 1. A random state parameter for CSRF protection
 * 2. The authorization URL with all parameters
 *
 * @param inviteToken - Optional invite token for new user registration
 * @returns The authorization URL and state
 * @throws Error if Discord OAuth is not configured
 */
export async function createDiscordAuthUrl(inviteToken?: string): Promise<DiscordAuthUrlResult> {
  const discord = getDiscordProvider();

  if (!discord) {
    throw new Error("Discord OAuth is not configured");
  }

  // Generate state parameter
  const state = generateState();

  // Store state and invite token for later use
  await storeState(state, inviteToken);

  // Create the authorization URL
  // Discord doesn't require PKCE, so we pass null for the code verifier
  const url = discord.createAuthorizationURL(state, null, DISCORD_SCOPES);

  return {
    url: url.toString(),
    state,
  };
}

/**
 * Validates a Discord OAuth callback and retrieves user information
 *
 * This:
 * 1. Retrieves the state from Redis
 * 2. Exchanges the authorization code for tokens
 * 3. Fetches the user's Discord profile
 *
 * @param code - The authorization code from Discord
 * @param state - The state parameter for verification
 * @returns The user info and tokens
 * @throws Error if Discord OAuth is not configured, state is invalid, or code exchange fails
 */
export async function validateDiscordCallback(
  code: string,
  state: string
): Promise<DiscordAuthResult> {
  const discord = getDiscordProvider();

  if (!discord) {
    throw new Error("Discord OAuth is not configured");
  }

  // Retrieve and consume the state data
  const stateData = await consumeState(state);

  if (!stateData) {
    throw new Error("Invalid or expired OAuth state");
  }

  // Exchange the authorization code for tokens
  // Discord doesn't require PKCE, so we pass null for the code verifier
  const tokens = await discord.validateAuthorizationCode(code, null);

  // Fetch user info from Discord
  const userInfo = await fetchDiscordUserInfo(tokens.accessToken());

  return {
    userInfo,
    tokens: {
      accessToken: tokens.accessToken(),
      refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined,
      expiresAt: tokens.accessTokenExpiresAt(),
    },
    inviteToken: stateData.inviteToken,
  };
}

/**
 * Fetches user information from Discord's /users/@me endpoint
 *
 * @param accessToken - The OAuth access token
 * @returns The user's Discord profile
 * @throws Error if the request fails
 */
async function fetchDiscordUserInfo(accessToken: string): Promise<DiscordUserInfo> {
  const response = await fetch("https://discord.com/api/users/@me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch Discord user info: ${error}`);
  }

  const userInfo = (await response.json()) as DiscordUserInfo;

  // Validate required fields
  if (!userInfo.id || !userInfo.email) {
    throw new Error("Discord user info is missing required fields");
  }

  // Discord requires email verification for OAuth apps requesting email scope
  if (!userInfo.verified) {
    throw new Error("Discord email is not verified");
  }

  return userInfo;
}

/**
 * Checks if Discord OAuth is available
 *
 * @returns Whether Discord OAuth is configured and enabled
 */
export function isDiscordOAuthEnabled(): boolean {
  return isProviderEnabled("discord");
}
