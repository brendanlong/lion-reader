/**
 * Apple OAuth Flow Implementation
 *
 * This module handles the Apple OAuth flow including:
 * - Generating authorization URLs
 * - Storing/retrieving state in Redis
 * - Exchanging authorization codes for tokens
 * - Verifying Apple's JWT id_token for user info
 *
 * Important Apple-specific considerations:
 * - Apple only sends the email on FIRST authorization
 * - Users may use Apple's private relay email (randomized@privaterelay.appleid.com)
 * - Apple uses JWT id_token to convey user information
 * - Apple requires response_mode=form_post for the callback
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import * as client from "openid-client";
import {
  APPLE_ISSUER,
  APPLE_JWKS_URI,
  getAppleAuthorizationConfig,
  getAppleTokenConfig,
  getAppleClientId,
  getRedirectUri,
} from "./config";
import {
  consumeOAuthState,
  exchangeAuthorizationCode,
  signInOrLinkFlow,
  storeOAuthState,
  tokensFromResponse,
  type OAuthAuthUrl,
  type PendingOAuthCallback,
  type SignInOrLinkState,
} from "./token-exchange";

/**
 * Clock-skew allowance (seconds) when checking the id_token `exp` claim. Matches the
 * OAuth client's own tolerance, which is applied to `exp` first during the exchange —
 * a larger value here would be unreachable.
 */
const CLOCK_SKEW_SECONDS = 30;

/**
 * Lazily-created remote JWKS resolver (cached across requests; `jose` handles key
 * caching and rotation internally). Created on first use so importing this module
 * doesn't open a network handle.
 */
let appleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getAppleJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!appleJwks) {
    appleJwks = createRemoteJWKSet(new URL(APPLE_JWKS_URI));
  }
  return appleJwks;
}

// ============================================================================
// Constants
// ============================================================================

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
  auth_time: number;
  nonce_supported: boolean;
}

// ============================================================================
// JWT Decoding
// ============================================================================

/**
 * Verifies an Apple JWT id_token and returns its claims.
 *
 * Full verification via `jose`:
 *   - signature against Apple's published JWKS (defeats a forged token)
 *   - `iss` must be Apple's issuer
 *   - `aud` must be our configured client ID (defeats token/audience confusion)
 *   - `exp` must be in the future (with a small clock-skew allowance)
 *
 * The token also arrives over a direct server-to-Apple TLS `authorization_code`
 * exchange, but we do not rely on that alone — the claims and signature are checked.
 * `openid-client` re-checks `iss`/`aud`/`exp` during the exchange but deliberately
 * skips the signature for tokens fetched straight from the token endpoint (OIDC Core
 * §3.1.3.7 lets TLS stand in for it), so this step is what makes a forged id_token fail.
 *
 * @param idToken - The JWT id_token from Apple
 * @returns The verified payload
 * @throws Error if the token is malformed, forged, expired, or minted for another client
 */
async function verifyAppleIdToken(idToken: string): Promise<AppleJWTPayload> {
  const expectedAud = getAppleClientId();
  if (!expectedAud) {
    throw new Error("Apple OAuth is not configured");
  }

  const { payload } = await jwtVerify(idToken, getAppleJwks(), {
    issuer: APPLE_ISSUER,
    audience: expectedAud,
    clockTolerance: CLOCK_SKEW_SECONDS,
  });

  if (typeof payload.sub !== "string") {
    throw new Error("Apple id_token is missing a subject");
  }

  return payload as unknown as AppleJWTPayload;
}

// ============================================================================
// Apple OAuth Functions
// ============================================================================

/**
 * Generates an Apple OAuth authorization URL, storing the flow in Redis under the
 * returned `state`. Apple doesn't use PKCE like Google does.
 *
 * @throws Error if Apple OAuth is not configured
 */
export async function createAppleAuthUrl(options: SignInOrLinkState = {}): Promise<OAuthAuthUrl> {
  const config = getAppleAuthorizationConfig();

  if (!config) {
    throw new Error("Apple OAuth is not configured");
  }

  const state = client.randomState();

  await storeOAuthState(STATE_PREFIX + state, {
    inviteToken: options.inviteToken,
    link: options.link,
  } satisfies SignInOrLinkState);

  // Apple requires response_mode=form_post when requesting name or email scopes
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: getRedirectUri("apple"),
    scope: APPLE_SCOPES.join(" "),
    state,
    response_mode: "form_post",
  });

  return { url: url.toString(), state };
}

/**
 * Consumes an Apple callback's state.
 *
 * The identity comes **only** from the signature-verified id_token. Apple also posts
 * a `user` form value with a name and email on first authorization, but the client
 * posts it, so it is attacker-controllable and deliberately never read: an email
 * taken from it would decide which account a sign-in links into. Returning users
 * (no email on re-auth) are matched by `sub`.
 *
 * @throws OAuthStateError if the state is unknown, expired or already used
 */
export async function beginAppleCallback(state: string): Promise<PendingOAuthCallback> {
  const stateData = await consumeOAuthState<SignInOrLinkState>(STATE_PREFIX + state);

  return {
    flow: signInOrLinkFlow(stateData),
    async complete(code) {
      const config = await getAppleTokenConfig();
      if (!config) {
        throw new Error("Apple OAuth is not configured");
      }

      // Apple doesn't use PKCE
      const tokens = await exchangeAuthorizationCode(config, getRedirectUri("apple"), {
        code,
        state,
      });

      if (!tokens.id_token) {
        throw new Error("Apple did not return an id_token");
      }
      const claims = await verifyAppleIdToken(tokens.id_token);

      return {
        providerAccountId: claims.sub,
        email: claims.email,
        // Apple may send the claim as the string "true"/"false" or a boolean
        emailVerified: claims.email_verified === true || claims.email_verified === "true",
        ...tokensFromResponse(tokens),
      };
    },
  };
}
