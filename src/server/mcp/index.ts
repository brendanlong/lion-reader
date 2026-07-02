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
import { registerTools, toMcpError } from "./tools.js";
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

    // stdio is a trusted local single-user transport with no authentication
    // layer: the acting user is configured at server startup via
    // LION_READER_USER_ID. Identity is a property of the session, not of each
    // call — the advertised tool schemas deliberately have no userId argument
    // (they set additionalProperties: false, so clients can't pass one).
    const userId = process.env.LION_READER_USER_ID;
    if (!userId) {
      throw new Error(
        "No user configured: set the LION_READER_USER_ID environment variable to the user's ID"
      );
    }
    const result = await tool.handler(db, userId, args ?? {});

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
    throw toMcpError(error);
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
