/**
 * Calls MCP tool handlers in integration tests. Kept out of
 * `tests/integration/helpers.ts`: the tools import the whole services layer,
 * and some test files set provider env vars before importing modules that read
 * them at load time.
 */

import { db } from "../../src/server/db";
import { getTools } from "../../src/server/mcp/tools";
import { userRow } from "../integration/helpers";

/** Calls an MCP tool's handler as `userId`, read fresh like the MCP route does per request. */
export async function callMcpTool(name: string, userId: string, args: unknown): Promise<unknown> {
  const tool = getTools().find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.handler(db, await userRow(userId), args);
}
