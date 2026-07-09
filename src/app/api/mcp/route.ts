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
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { db } from "@/server/db";
import { registerTools, toMcpError } from "@/server/mcp/tools";
import { isSignupConfirmed } from "@/server/auth/confirmation";
import { validateApiToken, API_TOKEN_SCOPES } from "@/server/auth/api-token";
import { validateAccessToken } from "@/server/oauth/service";
import { OAUTH_SCOPES, isResourceForThisServer } from "@/server/oauth/utils";
import {
  getAcceptedResourceIdentifiers,
  getProtectedResourceMetadataUrl,
} from "@/server/oauth/config";
import { withMcpCorsHeaders, mcpCorsPreflight } from "@/server/http/cors";
import { logger } from "@/lib/logger";

// ============================================================================
// Authentication
// ============================================================================

type AuthSuccess = { success: true; userId: string };
type AuthFailure = { success: false; reason: string; status?: 401 | 403 };
type AuthResult = AuthSuccess | AuthFailure;

/**
 * Extract and validate token from request headers.
 * Supports both OAuth 2.1 access tokens and legacy API tokens.
 * Returns userId if valid, or a reason string for failure.
 */
async function authenticateRequest(request: NextRequest): Promise<AuthResult> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return { success: false, reason: "no_authorization_header" };
  }
  if (!authHeader.startsWith("Bearer ")) {
    return { success: false, reason: "invalid_authorization_scheme" };
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix

  // Try OAuth access token first (new system)
  const oauthToken = await validateAccessToken(token);
  if (oauthToken) {
    // Check if OAuth token has MCP scope
    if (!oauthToken.scopes.includes(OAUTH_SCOPES.MCP)) {
      logger.warn("MCP auth: OAuth token missing MCP scope", {
        userId: oauthToken.userId,
        scopes: oauthToken.scopes,
      });
      return { success: false, reason: "oauth_token_missing_mcp_scope" };
    }
    // Enforce RFC 8707 audience binding: a token minted for a different resource
    // must not be accepted here. Newly issued tokens always carry a resource
    // (bound at authorization time); only legacy tokens issued before audience
    // binding may have a null resource, which we still accept. We accept either
    // the canonical MCP-endpoint resource or the bare origin (the pre-2026-07
    // canonical value) so tokens minted before the identifier change stay valid.
    const acceptedResources = getAcceptedResourceIdentifiers();
    if (oauthToken.resource && !isResourceForThisServer(oauthToken.resource, acceptedResources)) {
      logger.warn("MCP auth: OAuth token resource/audience mismatch", {
        userId: oauthToken.userId,
        tokenResource: oauthToken.resource,
        acceptedResources,
      });
      return { success: false, reason: "oauth_token_audience_mismatch" };
    }
    if (!isSignupConfirmed(oauthToken.user)) {
      logger.warn("MCP auth: user has not completed signup confirmation", {
        userId: oauthToken.userId,
      });
      return { success: false, reason: "signup_confirmation_required", status: 403 };
    }
    return { success: true, userId: oauthToken.userId };
  }

  // Fall back to API token (legacy system)
  const apiTokenData = await validateApiToken(token);
  if (apiTokenData) {
    // Check if token has MCP scope
    if (!apiTokenData.token.scopes.includes(API_TOKEN_SCOPES.MCP)) {
      logger.warn("MCP auth: API token missing MCP scope", {
        userId: apiTokenData.user.id,
        scopes: apiTokenData.token.scopes,
      });
      return { success: false, reason: "api_token_missing_mcp_scope" };
    }
    if (!isSignupConfirmed(apiTokenData.user)) {
      logger.warn("MCP auth: user has not completed signup confirmation", {
        userId: apiTokenData.user.id,
      });
      return { success: false, reason: "signup_confirmation_required", status: 403 };
    }
    return { success: true, userId: apiTokenData.user.id };
  }

  return { success: false, reason: "token_invalid_expired_or_revoked" };
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
 */
function buildWwwAuthenticateHeader(): string {
  const metadataUrl = getProtectedResourceMetadataUrl();
  return `Bearer realm="OAuth", resource_metadata="${metadataUrl}", error="invalid_token", error_description="Missing or invalid access token"`;
}

// ============================================================================
// MCP Server Factory
// ============================================================================

/**
 * Creates a new MCP Server instance with tools registered.
 * Each request gets its own server instance (stateless pattern).
 *
 * @param userId - The authenticated user's ID, injected into tool handlers
 */
function createMcpServer(userId: string): Server {
  const server = new Server(
    {
      name: "lion-reader",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = registerTools();
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tools = registerTools();
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    // The authenticated userId is passed separately from client args, so it
    // can't be spoofed; the handler validates args against its Zod schema.
    let result: unknown;
    try {
      result = await tool.handler(db, userId, args ?? {});
    } catch (error) {
      throw toMcpError(error);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  return server;
}

// ============================================================================
// Unauthorized Response
// ============================================================================

function unauthorizedResponse(failure: AuthFailure): Response {
  logger.warn("MCP auth unauthorized", { reason: failure.reason });
  const status = failure.status ?? 401;
  return new Response(JSON.stringify({ error: status === 403 ? "Forbidden" : "Unauthorized" }), {
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
    return unauthorizedResponse(auth);
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
    return withMcpCorsHeaders(unauthorizedResponse(auth));
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
    return withMcpCorsHeaders(unauthorizedResponse(auth));
  }
  return withMcpCorsHeaders(new Response(null, { status: 405 }));
}
