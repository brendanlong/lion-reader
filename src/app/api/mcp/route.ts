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

/**
 * Extract and validate token from request headers.
 * Supports both OAuth 2.1 access tokens and legacy API tokens.
 * Returns userId if valid, null otherwise.
 */
async function authenticateRequest(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix

  // Try OAuth access token first (new system)
  const oauthToken = await validateAccessToken(token);
  if (oauthToken) {
    // Check if OAuth token has MCP scope
    if (!oauthToken.scopes.includes(OAUTH_SCOPES.MCP)) {
      logger.warn("OAuth token missing MCP scope", { userId: oauthToken.userId });
      return null;
    }
    return oauthToken.userId;
  }

  // Fall back to API token (legacy system)
  const apiTokenData = await validateApiToken(token);
  if (apiTokenData) {
    // Check if token has MCP scope
    if (!apiTokenData.token.scopes.includes(API_TOKEN_SCOPES.MCP)) {
      logger.warn("API token missing MCP scope", { userId: apiTokenData.user.id });
      return null;
    }
    return apiTokenData.user.id;
  }

  return null;
}

/**
 * Builds WWW-Authenticate header for 401 responses.
 * Includes resource_metadata URL per MCP specification.
 */
function buildWwwAuthenticateHeader(): string {
  const metadata = getProtectedResourceMetadata();
  return `Bearer resource_metadata="${metadata.resource}/.well-known/oauth-protected-resource"`;
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

function unauthorizedResponse(): Response {
  logger.warn("MCP request unauthorized");
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
  const userId = await authenticateRequest(request);
  if (!userId) {
    return unauthorizedResponse();
  }

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
 * In stateless mode, returns 405 since there are no persistent sessions.
 */
export function GET() {
  return new Response(null, { status: 405 });
}

/**
 * DELETE /api/mcp - Session termination
 *
 * In stateless mode, returns 405 since there are no sessions to terminate.
 */
export function DELETE() {
  return new Response(null, { status: 405 });
}
