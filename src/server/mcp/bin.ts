#!/usr/bin/env tsx
/**
 * MCP stdio Server Entry Point
 *
 * Starts the Lion Reader MCP server over stdio for Claude Desktop or other
 * local MCP clients.
 *
 * Usage:
 *   pnpm mcp:serve
 *
 * Or directly:
 *   tsx src/server/mcp/bin.ts
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "@/server/mcp/server";
import { logger } from "@/lib/logger";

async function main(): Promise<void> {
  // stdio is a trusted local single-user transport with no authentication
  // layer: the acting user is configured at startup via LION_READER_USER_ID.
  const userId = process.env.LION_READER_USER_ID;
  if (!userId) {
    throw new Error(
      "No user configured: set the LION_READER_USER_ID environment variable to the user's ID"
    );
  }

  const server = createMcpServer(userId);
  await server.connect(new StdioServerTransport());
  logger.info("Lion Reader MCP server started");
}

main().catch((error) => {
  logger.error("MCP server error", { error });
  process.exit(1);
});
