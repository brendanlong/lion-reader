# Lion Reader MCP Server

Model Context Protocol (MCP) server exposing Lion Reader to AI assistants. See the [Design Document](../../../docs/DESIGN.md#mcp-server) for architecture; tools are defined in `tools.ts` (shared by both transports) and call the services layer (`src/server/services/`).

## Transports

### Streamable HTTP (hosted)

Remote clients (e.g. claude.ai) connect to `https://your-app/api/mcp` and authenticate with either:

- **OAuth 2.1** — clients register via Dynamic Client Registration and go through the standard authorization flow (recommended; this is what claude.ai does automatically), or
- **API token** — create a token with the `mcp` scope under Settings → API Tokens and send it as `Authorization: Bearer <token>`.

### stdio (local development)

```bash
pnpm mcp:serve
```

The stdio transport has no authentication layer — it acts as the single user configured via `LION_READER_USER_ID` (a `users.id` UUID). Claude Desktop config:

```json
{
  "mcpServers": {
    "lion-reader-local": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/lion-reader", "mcp:serve"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "REDIS_URL": "redis://...",
        "LION_READER_USER_ID": "<your user's UUID>"
      }
    }
  }
}
```

## Adding New Tools

1. Add a service function in `src/server/services/{domain}.ts`
2. Define the tool (with a Zod input schema) in `tools.ts` and register it in `registerTools()`
3. If the tool mirrors a tRPC endpoint, keep the endpoint's scope handling in sync (see "Token Scopes & Authorization" in the Design Document)
