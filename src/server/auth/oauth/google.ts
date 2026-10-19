/**
 * Google OAuth Flow Implementation
 *
 * This module handles the Google OAuth flow including:
 * - Generating authorization URLs with PKCE
 * - Storing/retrieving PKCE verifiers in Redis
 * - Exchanging authorization codes for tokens
 * - Fetching user info from Google
 */

import * as client from "openid-client";
import { GOOGLE_DOCS_SCOPES } from "@/server/google/tokens";
import { getGoogleConfig, getRedirectUri } from "./config";
import {
  beginOAuthCallback,
  exchangeAuthorizationCode,
  fetchUserInfo,
  OAuthStateError,
  signInOrLinkFlow,
  storeOAuthState,
  tokensFromResponse,
  type OAuthAuthUrl,
  type OAuthFlow,
  type PendingOAuthCallback,
  type SignInOrLinkState,
} from "./token-exchange";

// ============================================================================
// Constants
// ============================================================================

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
interface GoogleUserInfo {
  /** Google's unique user ID (subject) */
  sub: string;
  /** User's email address */
  email: string;
  /** Whether the email has been verified */
  email_verified: boolean;
}

/**
 * Incremental authorization for Google Docs, re-authorizing the flow user's existing
 * link. `save` returns to /save, `extension-save` to the extension save page.
 */
type DocsAccess =
  { userId: string; mode: "save" } | { userId: string; mode: "extension-save"; returnUrl: string };

/** A sign-in or link (the default), or a Docs-access re-authorization. */
export type GoogleAuthUrlOptions = SignInOrLinkState | { docsAccess: DocsAccess };

/**
 * Data stored in Redis for PKCE verification. `mode` is "login" for a sign-in or a
 * link; the Docs-access modes carry their user.
 */
interface PkceData extends SignInOrLinkState {
  verifier: string;
  mode: "login" | DocsAccess["mode"];
  /** The user whose link a Docs-access flow re-authorizes */
  userId?: string;
  /** Where `extension-save` returns the user afterwards */
  returnUrl?: string;
}

// ============================================================================
// Google OAuth Functions
// ============================================================================

/**
 * Generates a Google OAuth authorization URL with PKCE, storing the code verifier
 * and the flow in Redis under the returned `state`.
 *
 * @throws Error if Google OAuth is not configured
 */
export async function createGoogleAuthUrl(
  options: GoogleAuthUrlOptions = {}
): Promise<OAuthAuthUrl> {
  const config = getGoogleConfig();

  if (!config) {
    throw new Error("Google OAuth is not configured");
  }

  const state = client.randomState();
  const codeVerifier = client.randomPKCECodeVerifier();

  let scopes = GOOGLE_SCOPES;
  let data: PkceData;
  if ("docsAccess" in options) {
    const { docsAccess } = options;
    scopes = [...GOOGLE_SCOPES, ...GOOGLE_DOCS_SCOPES];
    data = {
      verifier: codeVerifier,
      mode: docsAccess.mode,
      userId: docsAccess.userId,
      returnUrl: docsAccess.mode === "extension-save" ? docsAccess.returnUrl : undefined,
    };
  } else {
    data = { verifier: codeVerifier, mode: "login", ...options };
  }
  await storeOAuthState(PKCE_VERIFIER_PREFIX + state, data);

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: getRedirectUri("google"),
    scope: scopes.join(" "),
    state,
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    // Without this, a plain sign-in's token would carry only the sign-in scopes and
    // we'd record the Docs/Drive grant as lost (#1803).
    include_granted_scopes: "true",
  });

  return { url: url.toString(), state };
}

function flowFromPkceData(data: PkceData): OAuthFlow {
  if (data.mode === "login") {
    return signInOrLinkFlow(data);
  }

  // A Docs-access flow without its user can't be honoured, and must not become a
  // sign-in.
  const returnPath = data.mode === "save" ? "/save" : data.returnUrl;
  if (!data.userId || !returnPath) {
    throw new OAuthStateError();
  }

  return {
    kind: "reauthorize",
    userId: data.userId,
    returnPath,
    // `extension-save` is exempt from the state cookie (SECURITY.md §4) because its
    // auth URL is generated in a Server Component (src/app/(spa)/extension/save/page.tsx),
    // which Next.js forbids from setting cookies. It only refreshes the tokens on the
    // flow user's own link and signs no one in, so it isn't the login-CSRF vector. If
    // that flow ever moves to a Route Handler (which can set cookies), drop this.
    browserBound: data.mode !== "extension-save",
  };
}

/**
 * Reads a Google callback's state: the PKCE verifier and the flow.
 *
 * @throws OAuthStateError if the state is unknown, expired or already used
 */
export async function beginGoogleCallback(state: string): Promise<PendingOAuthCallback> {
  return beginOAuthCallback<PkceData>(PKCE_VERIFIER_PREFIX + state, (pkceData) => {
    // An empty verifier must fail closed: the client treats a falsy `pkceCodeVerifier` as
    // "this flow used no PKCE" and would silently drop the proof from the token request.
    if (!pkceData.verifier) {
      throw new OAuthStateError();
    }

    return {
      flow: flowFromPkceData(pkceData),
      async exchange(code) {
        const config = getGoogleConfig();
        if (!config) {
          throw new Error("Google OAuth is not configured");
        }

        const tokens = await exchangeAuthorizationCode(config, getRedirectUri("google"), {
          code,
          state,
          codeVerifier: pkceData.verifier,
        });
        const userInfo = await fetchGoogleUserInfo(tokens.access_token);

        return {
          providerAccountId: userInfo.sub,
          email: userInfo.email,
          emailVerified: userInfo.email_verified === true,
          ...tokensFromResponse(tokens),
        };
      },
    };
  });
}

/**
 * Fetches user information from Google's userinfo endpoint
 *
 * @param accessToken - The OAuth access token
 * @returns The user's Google profile
 * @throws Error if the request fails
 */
async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const userInfo = await fetchUserInfo<GoogleUserInfo>(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    accessToken,
    "Google"
  );

  // Validate required fields
  if (!userInfo.sub || !userInfo.email) {
    throw new Error("Google user info is missing required fields");
  }

  return userInfo;
}
