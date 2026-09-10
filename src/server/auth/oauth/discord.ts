/**
 * Discord OAuth Flow Implementation
 *
 * This module handles the Discord OAuth flow including:
 * - Generating authorization URLs with state
 * - Storing/retrieving state in Redis
 * - Exchanging authorization codes for tokens
 * - Fetching user info from Discord
 */

import * as client from "openid-client";
import {
  getDiscordConfig,
  getRedirectUri,
  isProviderEnabled,
  type OAuthLinkTarget,
} from "./config";
import { accessTokenExpiresAt, exchangeAuthorizationCode } from "./token-exchange";
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
  /** Set when this flow is a link: the account it attaches to */
  link?: OAuthLinkTarget;
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
  /** Present when this flow is a link (see `OAuthLinkTarget`) */
  link?: OAuthLinkTarget;
}

/**
 * Stores state data in Redis
 */
async function storeState(state: string, data: StateData): Promise<void> {
  const key = getStateKey(state);
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

export interface CreateDiscordAuthUrlOptions {
  /** Invite token for new user registration */
  inviteToken?: string;
  /** Link this Discord account to the given account instead of signing in */
  link?: OAuthLinkTarget;
}

/**
 * Generates a Discord OAuth authorization URL
 *
 * This creates:
 * 1. A random state parameter for CSRF protection
 * 2. The authorization URL with all parameters
 *
 * @returns The authorization URL and state
 * @throws Error if Discord OAuth is not configured
 */
export async function createDiscordAuthUrl(
  options: CreateDiscordAuthUrlOptions = {}
): Promise<DiscordAuthUrlResult> {
  const config = getDiscordConfig();

  if (!config) {
    throw new Error("Discord OAuth is not configured");
  }

  // Generate state parameter
  const state = client.randomState();

  // Store the link target and invite token for later use
  await storeState(state, { inviteToken: options.inviteToken, link: options.link });

  // Create the authorization URL (Discord doesn't require PKCE)
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: getRedirectUri("discord"),
    scope: DISCORD_SCOPES.join(" "),
    state,
  });

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
  const config = getDiscordConfig();

  if (!config) {
    throw new Error("Discord OAuth is not configured");
  }

  // Retrieve and consume the state data
  const stateData = await consumeState(state);

  if (!stateData) {
    throw new Error("Invalid or expired OAuth state");
  }

  // Exchange the authorization code for tokens (Discord doesn't require PKCE)
  const tokens = await exchangeAuthorizationCode(config, getRedirectUri("discord"), {
    code,
    state,
  });

  // Fetch user info from Discord
  const userInfo = await fetchDiscordUserInfo(tokens.access_token);

  return {
    userInfo,
    tokens: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: accessTokenExpiresAt(tokens),
    },
    inviteToken: stateData.inviteToken,
    link: stateData.link,
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
