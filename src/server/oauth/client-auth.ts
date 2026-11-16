/**
 * Request parsing and OAuth client authentication shared by the token and
 * revocation endpoints.
 *
 * Supports the client authentication methods advertised in the RFC 8414
 * metadata (`token_endpoint_auth_methods_supported` in config.ts):
 * - `client_secret_basic` — credentials in an HTTP Basic `Authorization` header
 * - `client_secret_post` — credentials in the form body
 * - `none` — public client, `client_id` in the body only
 */

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { hashToken, OAUTH_ERRORS, createOAuthError, type OAuthErrorResponse } from "./utils";
import { resolveClient, type ResolvedClient } from "./clients";

const jsonBodySchema = z.record(z.string(), z.unknown());

export function invalidRequest(description: string): Response {
  return NextResponse.json(createOAuthError(OAUTH_ERRORS.INVALID_REQUEST, description), {
    status: 400,
  });
}

/**
 * Reads the form-encoded or JSON request body as string parameters, or returns
 * an `invalid_request` response for another content type or a body that isn't
 * a JSON object. Non-string JSON values are dropped.
 */
export async function parseOAuthBody(request: Request): Promise<Record<string, string> | Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    return Object.fromEntries(Array.from(formData.entries()).map(([k, v]) => [k, String(v)]));
  }
  if (!contentType.includes("application/json")) {
    logger.warn("OAuth request: unsupported content type", { contentType });
    return invalidRequest("Unsupported content type");
  }
  const parsed = jsonBodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return invalidRequest("Request body must be a JSON object");
  }
  return Object.fromEntries(
    Object.entries(parsed.data).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

/**
 * Authenticates the client of a token or revocation request: extracts its
 * credentials, requires a client_id, resolves the client and checks its
 * secret. Returns the client, or the OAuth error response to send.
 */
export async function authenticateClient(
  request: Request,
  body: Record<string, string>
): Promise<ResolvedClient | Response> {
  const extracted = extractClientCredentials(request.headers.get("authorization"), body);
  if (!extracted.success) {
    logger.warn("OAuth client credential extraction failed", {
      error: extracted.error.error_description,
    });
    return NextResponse.json(extracted.error, { status: extracted.status });
  }
  const { clientId, clientSecret } = extracted.credentials;
  if (!clientId) {
    return invalidRequest("Missing client_id parameter");
  }

  const client = await resolveClient(clientId);
  if (!client) {
    return NextResponse.json(createOAuthError(OAUTH_ERRORS.INVALID_CLIENT, "Unknown client_id"), {
      status: 401,
    });
  }
  const secretError = clientSecretError(client, clientSecret);
  if (secretError) {
    return NextResponse.json(secretError, { status: 401 });
  }
  return client;
}

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
