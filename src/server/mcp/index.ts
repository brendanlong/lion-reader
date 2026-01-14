/**
 * MCP (Model Context Protocol) Server
 *
 * Exposes Lion Reader functionality to AI assistants via MCP.
 * Uses service layer functions for business logic.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { db } from "@/server/db";
import { registerTools } from "./tools.js";
import { logger } from "@/lib/logger";

// ============================================================================
// Server Setup
// ============================================================================

const server = new Server(
  {
    name: "lion-reader",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ============================================================================
// Request Handlers
// ============================================================================

/**
 * List available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = registerTools();
  return { tools };
});

/**
 * Execute a tool
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const tools = registerTools();
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // Tool handlers will use services to execute operations
    const result = await tool.handler(db, args ?? {});

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    logger.error("MCP tool execution error", { tool: name, error });
    throw error;
  }
});

/**
 * List available resources (placeholder for now)
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: [] };
});

/**
 * Read a resource (placeholder for now)
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  throw new Error(`Resource not found: ${request.params.uri}`);
});

// ============================================================================
// Server Lifecycle
// ============================================================================

/**
 * Start the MCP server
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Lion Reader MCP server started");
}

main().catch((error) => {
  logger.error("MCP server error", { error });
  process.exit(1);
});
