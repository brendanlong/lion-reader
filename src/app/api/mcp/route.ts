/**
 * MCP (Model Context Protocol) HTTP Endpoint
 *
 * Serves the MCP server over Streamable HTTP transport with authentication.
 * Supports both OAuth 2.1 tokens and legacy API tokens.
 *
 * Uses WebStandardStreamableHTTPServerTransport from the MCP SDK,
 * which handles protocol negotiation, SSE streaming, and session management.
 *
 * Stateless mode: each request creates a fresh server+transport pair.
 * This is appropriate for Next.js serverless route handlers.
 */

import { NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/server/mcp/server";
import { extractBearerToken } from "@/server/auth/bearer";
import { authenticateCredential } from "@/server/auth/credential";
import { OAUTH_SCOPES } from "@/server/oauth/utils";
import { getProtectedResourceMetadataUrl } from "@/server/oauth/config";
import { withMcpCorsHeaders, mcpCorsPreflight } from "@/server/http/cors";
import { logger } from "@/lib/logger";

// ============================================================================
// Authentication
// ============================================================================

type AuthSuccess = { success: true; userId: string };
type AuthFailure = { success: false; reason: string; status?: 401 | 403 };
type AuthResult = AuthSuccess | AuthFailure;

/**
 * Accepts an `mcp`-scoped API token or an MCP client's OAuth token.
 * Returns userId if valid, or a reason string for failure.
 */
async function authenticateRequest(request: NextRequest): Promise<AuthResult> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return { success: false, reason: "no_authorization_header" };
  }
  const token = extractBearerToken(authHeader);
  if (!token) {
    return { success: false, reason: "invalid_authorization_scheme" };
  }

  const auth = await authenticateCredential(token, {
    accept: ["api_token", "mcp_token"],
    requiredScopes: [OAUTH_SCOPES.MCP],
    requireConfirmed: true,
  });
  if (auth.ok) {
    return { success: true, userId: auth.credential.user.id };
  }
  if (auth.reason === "unauthenticated") {
    // Includes another resource's OAuth token (the app's, Wallabag's).
    return { success: false, reason: "token_invalid_expired_revoked_or_other_audience" };
  }
  const { kind, user, scopes } = auth.credential;
  logger.warn("MCP auth: credential rejected", {
    reason: auth.reason,
    kind,
    userId: user.id,
    scopes,
  });
  return {
    success: false,
    reason: `${kind}_${auth.reason}`,
    // An unscoped token gets a 401 like a missing one, so the client re-authorizes.
    status: auth.reason === "unconfirmed" ? 403 : 401,
  };
}

/**
 * Builds WWW-Authenticate header for 401 responses (RFC 9728 / RFC 6750).
 *
 * `resource_metadata` points at the **path-inserted** protected-resource
 * metadata URL (authoritative for our path-bearing resource — see
 * getProtectedResourceMetadataUrl), matching what every known-working remote MCP
 * server advertises. The `realm`/`error` shape also mirrors those servers. We do
 * NOT include a `scope` parameter: working servers omit it, and ours would carry
 * a colon/space value (`mcp saved:write`) that risks tripping strict parsers.
 *
 */
function buildWwwAuthenticateHeader(): string {
  const metadataUrl = getProtectedResourceMetadataUrl();
  return `Bearer realm="OAuth", resource_metadata="${metadataUrl}", error="invalid_token", error_description="Missing or invalid access token"`;
}

// ============================================================================
// Unauthorized Response
// ============================================================================

function unauthorizedResponse(failure: AuthFailure, host: string | null): Response {
  logger.warn("MCP auth unauthorized", { reason: failure.reason, host });
  const status = failure.status ?? 401;
  // RFC 6750-style error body, byte-identical to what the known-working remote
  // MCP servers (Linear, Sentry, Notion) return on an unauthenticated request.
  const body =
    status === 403
      ? { error: "forbidden", error_description: "Access denied" }
      : { error: "invalid_token", error_description: "Missing or invalid access token" };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": buildWwwAuthenticateHeader(),
    },
  });
}

// ============================================================================
// Request Handler
// ============================================================================

/**
 * Handles an MCP request using the Streamable HTTP transport.
 * Creates a stateless server+transport pair per request.
 */
async function handleMcpRequest(request: NextRequest): Promise<Response> {
  // Authenticate request
  const auth = await authenticateRequest(request);
  if (!auth.success) {
    return unauthorizedResponse(auth, request.headers.get("host"));
  }
  const { userId } = auth;

  // Create a stateless MCP server and transport for this request
  const server = createMcpServer(userId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode
    enableJsonResponse: true, // Use JSON responses (our tools are fast DB queries)
  });

  await server.connect(transport);

  try {
    const response = await transport.handleRequest(request);
    logger.info("MCP request handled", { userId, method: request.method });
    return response;
  } catch (error) {
    logger.error("MCP endpoint error", { userId, error });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  } finally {
    // Clean up transport and server
    await transport.close();
    await server.close();
  }
}

// ============================================================================
// HTTP Method Handlers
// ============================================================================

/**
 * POST /api/mcp - Handle MCP JSON-RPC requests
 *
 * The Streamable HTTP transport handles:
 * - initialize requests (protocol negotiation)
 * - tools/list requests
 * - tools/call requests
 * - notifications
 */
export async function POST(request: NextRequest) {
  return withMcpCorsHeaders(await handleMcpRequest(request));
}

/**
 * OPTIONS /api/mcp - CORS preflight for in-browser MCP clients.
 */
export function OPTIONS() {
  return mcpCorsPreflight();
}

/**
 * GET /api/mcp - SSE endpoint for server-initiated messages
 *
 * Auth is checked first so unauthenticated clients receive 401 with
 * WWW-Authenticate header for OAuth discovery (MCP spec requirement).
 * In stateless mode, authenticated requests return 405 since there are
 * no persistent sessions for SSE streaming.
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth.success) {
    return withMcpCorsHeaders(unauthorizedResponse(auth, request.headers.get("host")));
  }
  return withMcpCorsHeaders(new Response(null, { status: 405 }));
}

/**
 * DELETE /api/mcp - Session termination
 *
 * Auth is checked first so unauthenticated clients receive 401 with
 * WWW-Authenticate header for OAuth discovery (MCP spec requirement).
 * In stateless mode, authenticated requests return 405 since there are
 * no sessions to terminate.
 */
export async function DELETE(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth.success) {
    return withMcpCorsHeaders(unauthorizedResponse(auth, request.headers.get("host")));
  }
  return withMcpCorsHeaders(new Response(null, { status: 405 }));
}
