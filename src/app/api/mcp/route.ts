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
        // Log the initialize request for debugging
        logger.info("MCP initialize request", { userId, params });

        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: {
              name: "lion-reader",
              version: "1.0.0",
            },
            capabilities: {
              tools: {},
            },
          },
        };
      }

      case "tools/list": {
        const tools = registerTools();
        // Return only MCP-compatible tool metadata (exclude handler)
        const toolList = tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        }));
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: toolList },
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
    logger.warn("MCP request unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const mcpRequest = (await request.json()) as MCPRequest;
    logger.info("MCP request received", { userId, method: mcpRequest.method, id: mcpRequest.id });

    // Validate JSON-RPC format
    if (mcpRequest.jsonrpc !== "2.0" || !mcpRequest.method) {
      logger.warn("Invalid MCP request format", { mcpRequest });
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
    logger.info("MCP response sent", {
      userId,
      method: mcpRequest.method,
      id: mcpRequest.id,
      hasError: !!response.error,
    });

    return NextResponse.json(response, {
      headers: {
        "Content-Type": "application/json",
      },
    });
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
