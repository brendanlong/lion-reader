/**
 * MCP Server Factory
 *
 * Builds the Lion Reader MCP server shared by both transports: the hosted
 * Streamable HTTP endpoint (`src/app/api/mcp/route.ts`) and the local stdio
 * server (`bin.ts`). Each transport authenticates (or configures) the acting
 * user its own way and passes it in here.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { db } from "@/server/db";
import { registerTools, toMcpError } from "@/server/mcp/tools";
import { logger } from "@/lib/logger";

/**
 * Creates an MCP Server with the Lion Reader tools registered, acting as
 * `userId`.
 *
 * The acting user is a property of the server (the authenticated request, or
 * the stdio process's configured user), never of a call: the advertised tool
 * schemas have no userId argument (they set additionalProperties: false, so
 * clients can't pass one), and each handler validates its args against its Zod
 * schema.
 */
export function createMcpServer(userId: string): Server {
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

    let result: unknown;
    try {
      result = await tool.handler(db, userId, args ?? {});
    } catch (error) {
      // Log the original error server-side; toMcpError replaces internal error
      // messages with a generic string so detail isn't echoed to clients (#1266).
      logger.error("MCP tool execution error", { tool: name, userId, error });
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
