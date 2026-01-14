# Lion Reader MCP Server

Model Context Protocol (MCP) server for Lion Reader, exposing feed reader functionality to AI assistants.

## Features

### Tools (Functions)

**Entries:**

- `list_entries` - List feed entries with filters and pagination
- `search_entries` - Full-text search across entries by title/content
- `get_entry` - Get single entry with full content
- `mark_entries_read` - Bulk mark entries as read/unread
- `star_entries` - Star/unstar entries
- `count_entries` - Get entry counts with filters

**Subscriptions:**

- `list_subscriptions` - List all feed subscriptions
- `search_subscriptions` - Search subscriptions by title
- `get_subscription` - Get subscription details

## Usage

### Running the Server

```bash
# Start the MCP server
pnpm mcp:serve
```

### Configuration for Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "lion-reader": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/lion-reader", "mcp:serve"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "REDIS_URL": "redis://..."
      }
    }
  }
}
```

Replace `/path/to/lion-reader` with the actual path to your Lion Reader installation.

## Authentication

Currently, all tools require a `userId` parameter for authentication. In production, this should be replaced with proper MCP authentication mechanisms (API tokens, OAuth, etc.).

**Temporary workaround:** Use your user ID from the database directly in tool calls.

## Architecture

The MCP server uses Lion Reader's **services layer** (`src/server/services/`) for business logic:

```
MCP Tools → Services → Database
         ↗
tRPC API → Services → Database
```

This design allows sharing logic between the web API and MCP server without duplication.

## Development

### Adding New Tools

1. Add service function in `src/server/services/{domain}.ts`
2. Add tool definition in `src/server/mcp/tools.ts`
3. Register tool in `registerTools()` function

### Testing

```bash
# Type check
pnpm typecheck

# Test services (used by MCP tools)
pnpm test:integration
```

## Future Enhancements

- **Resources:** Expose unread counts, subscription lists as MCP resources for context
- **Authentication:** Implement proper auth via API tokens or OAuth
- **Subscriptions:** Add create/delete subscription tools (currently read-only)
- **Saved Articles:** Add tools for saving/managing articles
- **Feed Preview:** Add tool for previewing feeds before subscribing
