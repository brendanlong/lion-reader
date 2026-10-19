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
import { getDiscordConfig, getRedirectUri } from "./config";
import {
  beginOAuthCallback,
  exchangeAuthorizationCode,
  fetchUserInfo,
  signInOrLinkFlow,
  storeOAuthState,
  tokensFromResponse,
  type OAuthAuthUrl,
  type PendingOAuthCallback,
  type SignInOrLinkState,
} from "./token-exchange";

// ============================================================================
// Constants
// ============================================================================

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
  /** User's email address (requires email scope) */
  email: string;
  /** Whether the email has been verified */
  verified: boolean;
}

// ============================================================================
// Discord OAuth Functions
// ============================================================================

/**
 * Generates a Discord OAuth authorization URL, storing the flow in Redis under the
 * returned `state`. Discord doesn't require PKCE.
 *
 * @throws Error if Discord OAuth is not configured
 */
export async function createDiscordAuthUrl(options: SignInOrLinkState = {}): Promise<OAuthAuthUrl> {
  const config = getDiscordConfig();

  if (!config) {
    throw new Error("Discord OAuth is not configured");
  }

  const state = client.randomState();

  await storeOAuthState(STATE_PREFIX + state, {
    inviteToken: options.inviteToken,
    returnPath: options.returnPath,
    link: options.link,
  } satisfies SignInOrLinkState);

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: getRedirectUri("discord"),
    scope: DISCORD_SCOPES.join(" "),
    state,
  });

  return { url: url.toString(), state };
}

/**
 * Reads a Discord callback's state.
 *
 * @throws OAuthStateError if the state is unknown, expired or already used
 */
export async function beginDiscordCallback(state: string): Promise<PendingOAuthCallback> {
  return beginOAuthCallback<SignInOrLinkState>(STATE_PREFIX + state, (stateData) => ({
    flow: signInOrLinkFlow(stateData),
    async exchange(code) {
      const config = getDiscordConfig();
      if (!config) {
        throw new Error("Discord OAuth is not configured");
      }

      const tokens = await exchangeAuthorizationCode(config, getRedirectUri("discord"), {
        code,
        state,
      });
      const userInfo = await fetchDiscordUserInfo(tokens.access_token);

      return {
        providerAccountId: userInfo.id,
        email: userInfo.email,
        emailVerified: userInfo.verified === true,
        ...tokensFromResponse(tokens),
      };
    },
  }));
}

/**
 * Fetches user information from Discord's /users/@me endpoint
 *
 * @param accessToken - The OAuth access token
 * @returns The user's Discord profile
 * @throws Error if the request fails
 */
async function fetchDiscordUserInfo(accessToken: string): Promise<DiscordUserInfo> {
  const userInfo = await fetchUserInfo<DiscordUserInfo>(
    "https://discord.com/api/users/@me",
    accessToken,
    "Discord"
  );

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
