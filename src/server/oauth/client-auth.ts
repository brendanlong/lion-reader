/**
 * OAuth client authentication shared by the token and revocation endpoints.
 *
 * Supports the client authentication methods advertised in the RFC 8414
 * metadata (`token_endpoint_auth_methods_supported` in config.ts):
 * - `client_secret_basic` — credentials in an HTTP Basic `Authorization` header
 * - `client_secret_post` — credentials in the form body
 * - `none` — public client, `client_id` in the body only
 */

import crypto from "node:crypto";
import { hashToken, OAUTH_ERRORS, createOAuthError, type OAuthErrorResponse } from "./utils";
import type { ResolvedClient } from "./service";

export interface ClientCredentials {
  clientId?: string;
  clientSecret?: string;
}

type ExtractResult =
  | { success: true; credentials: ClientCredentials }
  | { success: false; error: OAuthErrorResponse; status: 400 | 401 };

/**
 * Extracts client credentials from an HTTP Basic `Authorization` header
 * (RFC 6749 §2.3.1: client_id and client_secret are form-urlencoded, joined
 * with ":", then base64-encoded) merged with body parameters
 * (client_secret_post / public clients).
 *
 * Returns an error when the header is malformed or when the request uses two
 * authentication methods at once (forbidden by RFC 6749 §2.3).
 */
export function extractClientCredentials(
  authorizationHeader: string | null,
  body: Record<string, string>
): ExtractResult {
  const credentials: ClientCredentials = {
    clientId: body.client_id || undefined,
    clientSecret: body.client_secret || undefined,
  };

  if (!authorizationHeader || !/^basic\s/i.test(authorizationHeader)) {
    return { success: true, credentials };
  }

  let decoded: string;
  try {
    decoded = Buffer.from(authorizationHeader.slice(6).trim(), "base64").toString("utf-8");
  } catch {
    decoded = "";
  }
  const separator = decoded.indexOf(":");
  if (!decoded || separator === -1) {
    return {
      success: false,
      error: createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Malformed Basic authorization header"),
      status: 400,
    };
  }

  let basicClientId: string;
  let basicClientSecret: string;
  try {
    basicClientId = decodeURIComponent(decoded.slice(0, separator));
    basicClientSecret = decodeURIComponent(decoded.slice(separator + 1));
  } catch {
    return {
      success: false,
      error: createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, "Malformed Basic authorization header"),
      status: 400,
    };
  }

  // RFC 6749 §2.3: a request must not use more than one client authentication
  // method. A matching client_id in both places is tolerated (some clients
  // duplicate it); a second secret is not.
  if (credentials.clientId && credentials.clientId !== basicClientId) {
    return {
      success: false,
      error: createOAuthError(
        OAUTH_ERRORS.INVALID_REQUEST,
        "client_id in body does not match Basic authorization header"
      ),
      status: 400,
    };
  }
  if (credentials.clientSecret) {
    return {
      success: false,
      error: createOAuthError(
        OAUTH_ERRORS.INVALID_REQUEST,
        "Multiple client authentication methods used"
      ),
      status: 400,
    };
  }

  return {
    success: true,
    credentials: { clientId: basicClientId, clientSecret: basicClientSecret },
  };
}

/**
 * Validates a client secret for confidential clients. Public clients pass
 * without a secret. Returns an OAuth error (to be served with HTTP 401) or
 * null when the client is authenticated.
 */
export function clientSecretError(
  client: ResolvedClient,
  clientSecret: string | undefined
): OAuthErrorResponse | null {
  if (client.isPublic) {
    return null; // Public clients don't need secret validation
  }
  if (!clientSecret) {
    return createOAuthError(
      OAUTH_ERRORS.INVALID_CLIENT,
      "Missing client_secret for confidential client"
    );
  }
  const computedHash = hashToken(clientSecret);
  if (
    !client.clientSecretHash ||
    computedHash.length !== client.clientSecretHash.length ||
    !crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(client.clientSecretHash))
  ) {
    return createOAuthError(OAUTH_ERRORS.INVALID_CLIENT, "Invalid client_secret");
  }
  return null;
}
