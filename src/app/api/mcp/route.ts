/**
 * MCP (Model Context Protocol) HTTP Endpoint
 *
 * Serves the MCP server over HTTP with API token authentication.
 * This allows Claude Desktop and other MCP clients to connect to Lion Reader
 * hosted at lionreader.com or localhost:3000.
 *
 * Uses @modelcontextprotocol/server-fetch as the client-side proxy.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/server/db";
import { registerTools } from "@/server/mcp/tools";
import { validateApiToken, API_TOKEN_SCOPES } from "@/server/auth/api-token";
import { logger } from "@/lib/logger";

// ============================================================================
// Authentication
// ============================================================================

/**
 * Extract and validate API token from request headers.
 * Returns userId if valid, null otherwise.
 */
async function authenticateRequest(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix
  const tokenData = await validateApiToken(token);

  if (!tokenData) {
    return null;
  }

  // Check if token has MCP scope
  if (!tokenData.token.scopes.includes(API_TOKEN_SCOPES.MCP)) {
    logger.warn("API token missing MCP scope", { userId: tokenData.user.id });
    return null;
  }

  return tokenData.user.id;
}

// ============================================================================
// MCP Request Handlers
// ============================================================================

interface MCPRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Handle MCP protocol requests.
 */
async function handleMCPRequest(userId: string, request: MCPRequest): Promise<MCPResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize": {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "0.1.0",
            serverInfo: {
              name: "lion-reader",
              version: "0.1.0",
            },
            capabilities: {
              tools: {},
              resources: {},
            },
          },
        };
      }

      case "tools/list": {
        const tools = registerTools();
        return {
          jsonrpc: "2.0",
          id,
          result: { tools },
        };
      }

      case "tools/call": {
        const { name, arguments: args } = params as {
          name: string;
          arguments?: Record<string, unknown>;
        };
        const tools = registerTools();
        const tool = tools.find((t) => t.name === name);

        if (!tool) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Tool not found: ${name}`,
            },
          };
        }

        // Inject userId into args
        const result = await tool.handler(db, { userId, ...(args ?? {}) });

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        };
      }

      case "resources/list": {
        return {
          jsonrpc: "2.0",
          id,
          result: { resources: [] },
        };
      }

      default: {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
      }
    }
  } catch (error) {
    logger.error("MCP request error", { method, userId, error });
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error",
      },
    };
  }
}

// ============================================================================
// HTTP Endpoint
// ============================================================================

/**
 * POST /api/mcp - Handle MCP JSON-RPC requests
 */
export async function POST(request: NextRequest) {
  // Authenticate request
  const userId = await authenticateRequest(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const mcpRequest = (await request.json()) as MCPRequest;

    // Validate JSON-RPC format
    if (mcpRequest.jsonrpc !== "2.0" || !mcpRequest.method) {
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id: mcpRequest.id,
          error: {
            code: -32600,
            message: "Invalid Request",
          },
        },
        { status: 400 }
      );
    }

    // Handle the request
    const response = await handleMCPRequest(userId, mcpRequest);
    return NextResponse.json(response);
  } catch (error) {
    logger.error("MCP endpoint error", { userId, error });
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: "Parse error",
        },
      },
      { status: 500 }
    );
  }
}
