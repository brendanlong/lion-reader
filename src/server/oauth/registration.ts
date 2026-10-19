/**
 * OAuth Dynamic Client Registration (RFC 7591).
 */

import { db } from "@/server/db";
import { oauthClients } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  generateToken,
  hashToken,
  isValidRedirectUriFormat,
  OAUTH_SCOPES,
  SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS,
} from "./utils";
import { getRegistrationClientUri } from "./config";

/**
 * Client registration request as defined in RFC 7591
 */
export interface ClientRegistrationRequest {
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  scope?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  jwks_uri?: string;
  jwks?: object;
  software_id?: string;
  software_version?: string;
  software_statement?: string;
}

/**
 * Client registration response as defined in RFC 7591
 */
export interface ClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  client_secret_issued_at?: number;
  registration_client_uri?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  scope?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  jwks_uri?: string;
  jwks?: object;
  software_id?: string;
  software_version?: string;
}

/**
 * Error returned from client registration
 */
export interface ClientRegistrationError {
  error: string;
  error_description?: string;
}

/**
 * Generates a unique client ID for dynamic registration.
 */
function generateClientId(): string {
  // Use UUIDv7 for time-ordered client IDs
  return generateUuidv7();
}

/**
 * Registers a new OAuth client dynamically (RFC 7591).
 * Supports open registration (no initial access token required).
 *
 * @param request - Client registration request
 * @returns Client registration response or error
 */
export async function registerClient(
  request: ClientRegistrationRequest
): Promise<
  | { success: true; data: ClientRegistrationResponse }
  | { success: false; error: ClientRegistrationError }
> {
  // Validate required fields
  if (
    !request.redirect_uris ||
    !Array.isArray(request.redirect_uris) ||
    request.redirect_uris.length === 0
  ) {
    return {
      success: false,
      error: {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris is required and must be a non-empty array",
      },
    };
  }

  // Validate all redirect URIs
  for (const uri of request.redirect_uris) {
    if (!isValidRedirectUriFormat(uri)) {
      return {
        success: false,
        error: {
          error: "invalid_redirect_uri",
          error_description: `Invalid redirect URI: ${uri}. Must be HTTPS (or HTTP for localhost) and must not contain fragments.`,
        },
      };
    }
  }

  // Validate token_endpoint_auth_method. When omitted, RFC 7591 §2 defines the
  // default as client_secret_basic (a confidential client) — the working remote
  // MCP servers (Linear, Sentry, Notion) all follow this, so clients that omit
  // the field demonstrably handle receiving a secret.
  const authMethod = request.token_endpoint_auth_method ?? "client_secret_basic";
  if (!SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS.includes(authMethod)) {
    return {
      success: false,
      error: {
        error: "invalid_client_metadata",
        error_description: `Unsupported token_endpoint_auth_method: ${authMethod}. Supported methods: ${SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS.join(", ")}`,
      },
    };
  }

  // Determine if client is public or confidential
  const isPublic = authMethod === "none";

  // Generate client secret for confidential clients
  let clientSecret: string | undefined;
  let clientSecretHash: string | null = null;
  if (!isPublic) {
    clientSecret = generateToken();
    clientSecretHash = hashToken(clientSecret);
  }

  // Validate and normalize grant_types
  const requestedGrantTypes = request.grant_types ?? ["authorization_code"];
  const supportedGrantTypes = ["authorization_code", "refresh_token"];
  const grantTypes = requestedGrantTypes.filter((gt) => supportedGrantTypes.includes(gt));
  if (grantTypes.length === 0) {
    return {
      success: false,
      error: {
        error: "invalid_client_metadata",
        error_description: `No supported grant types. Supported: ${supportedGrantTypes.join(", ")}`,
      },
    };
  }

  // Validate response_types match grant_types (per RFC 7591 Section 2.1)
  const requestedResponseTypes = request.response_types ?? ["code"];
  const responseTypes: string[] = [];
  if (grantTypes.includes("authorization_code") && requestedResponseTypes.includes("code")) {
    responseTypes.push("code");
  }
  // Note: We don't support "implicit" grant type, so "token" response type is not allowed
  if (responseTypes.length === 0 && grantTypes.includes("authorization_code")) {
    responseTypes.push("code");
  }

  // Validate scope. A client that requests scopes gets exactly the supported
  // subset of those scopes. If none of the requested scopes are recognized we
  // reject the registration rather than silently broadening to "all scopes"
  // (defaulting unknown scopes to null/all is a privilege-escalation footgun).
  // When no scope is requested, scopes stays null (client may later request any
  // supported scope at authorization time, subject to user consent).
  const supportedScopes = Object.values(OAUTH_SCOPES);
  let scopes: string[] | null = null;
  if (request.scope) {
    const requestedScopes = request.scope.split(" ");
    const validScopes = Array.from(
      new Set(
        requestedScopes.filter((s) =>
          supportedScopes.includes(s as (typeof supportedScopes)[number])
        )
      )
    );
    if (validScopes.length === 0) {
      return {
        success: false,
        error: {
          error: "invalid_client_metadata",
          error_description: `None of the requested scopes are supported. Supported scopes: ${supportedScopes.join(", ")}`,
        },
      };
    }
    scopes = validScopes;
  }

  // Generate client ID
  const clientId = generateClientId();
  const clientName = request.client_name ?? "Unknown Application";

  // Store client in database
  const now = new Date();
  await db.insert(oauthClients).values({
    id: generateUuidv7(),
    clientId,
    name: clientName,
    redirectUris: request.redirect_uris,
    grantTypes,
    scopes,
    isPublic,
    clientSecretHash,
    createdAt: now,
    updatedAt: now,
  });

  // Build response
  const response: ClientRegistrationResponse = {
    client_id: clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    redirect_uris: request.redirect_uris,
    token_endpoint_auth_method: authMethod,
    grant_types: grantTypes,
    response_types: responseTypes,
    // Response-shape parity with the working remote MCP servers (Linear, Sentry,
    // Notion), which all include this field. RFC 7592 client management is not
    // implemented (theirs isn't either — Linear's URI 404s), and per RFC 7592 a
    // client can't use it anyway without a registration_access_token, which we
    // don't issue.
    registration_client_uri: getRegistrationClientUri(clientId),
  };

  // Add client_secret for confidential clients
  if (clientSecret) {
    response.client_secret = clientSecret;
    response.client_secret_expires_at = 0; // 0 means it doesn't expire
    // Not an RFC 7591 field, but BOTH Notion and Linear include it in
    // confidential-client registrations and they are the reference targets the
    // claude.ai connector demonstrably works against — a strict client response
    // model built against them could require it whenever client_secret is
    // present. Cheap parity; observed during the #986 subdomain debugging.
    response.client_secret_issued_at = Math.floor(now.getTime() / 1000);
  }

  // Add optional fields if provided
  if (request.client_name) {
    response.client_name = request.client_name;
  }
  if (request.client_uri) {
    response.client_uri = request.client_uri;
  }
  if (request.logo_uri) {
    response.logo_uri = request.logo_uri;
  }
  if (scopes) {
    response.scope = scopes.join(" ");
  }
  if (request.contacts) {
    response.contacts = request.contacts;
  }
  if (request.tos_uri) {
    response.tos_uri = request.tos_uri;
  }
  if (request.policy_uri) {
    response.policy_uri = request.policy_uri;
  }
  if (request.software_id) {
    response.software_id = request.software_id;
  }
  if (request.software_version) {
    response.software_version = request.software_version;
  }

  return { success: true, data: response };
}
