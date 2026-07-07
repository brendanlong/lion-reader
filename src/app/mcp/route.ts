/**
 * Root-level MCP endpoint alias (`/mcp`).
 *
 * The dedicated MCP host (`mcpConfig.host`, e.g. `mcp.lionreader.com`) serves the
 * MCP server at `/mcp` — the path every remote MCP server that works with the
 * claude.ai web connector uses (Notion/Linear/Sentry are all served at
 * `https://mcp.<host>/mcp`, with the bare origin 404/405ing). We re-export the
 * real handlers from
 * `/api/mcp` so the endpoint answers at `/mcp` on every host; the request `Host`
 * header (preserved by Next routing) drives host-aware behavior like the
 * `WWW-Authenticate` `resource_metadata` URL. `/api/mcp` remains for the apex and
 * for existing clients.
 *
 * NOTE: route-segment config (`export const runtime`/`dynamic`/…) does NOT
 * propagate through `export { … } from` (see src/app/authorize/route.ts).
 * `/api/mcp` declares none today; mirror it here if that ever changes.
 */
export { POST, GET, DELETE, OPTIONS } from "@/app/api/mcp/route";
