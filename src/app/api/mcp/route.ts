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
import { registerTools } from "@/server/mcp/tools";
import { validateApiToken, API_TOKEN_SCOPES } from "@/server/auth/api-token";
import { validateAccessToken } from "@/server/oauth/service";
import { OAUTH_SCOPES } from "@/server/oauth/utils";
import { getProtectedResourceMetadata } from "@/server/oauth/config";
import { logger } from "@/lib/logger";

// ============================================================================
// Authentication
// ============================================================================

type AuthSuccess = { success: true; userId: string };
type AuthFailure = { success: false; reason: string };
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
    return { success: true, userId: apiTokenData.user.id };
  }

  return { success: false, reason: "token_invalid_expired_or_revoked" };
}

/**
 * Builds WWW-Authenticate header for 401 responses.
 * Includes resource_metadata URL and scope per MCP specification (RFC 9728 / RFC 6750).
 */
function buildWwwAuthenticateHeader(): string {
  const metadata = getProtectedResourceMetadata();
  const scopes = Object.values(OAUTH_SCOPES);
  return `Bearer resource_metadata="${metadata.resource}/.well-known/oauth-protected-resource", scope="${scopes.join(" ")}"`;
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

    // Spread user args first, then set userId so it can't be overridden
    const result = await tool.handler(db, { ...(args ?? {}), userId });

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

function unauthorizedResponse(reason: string): Response {
  logger.warn("MCP auth unauthorized", { reason });
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
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
    return unauthorizedResponse(auth.reason);
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
  return handleMcpRequest(request);
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
    return unauthorizedResponse(auth.reason);
  }
  return new Response(null, { status: 405 });
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
    return unauthorizedResponse(auth.reason);
  }
  return new Response(null, { status: 405 });
}
