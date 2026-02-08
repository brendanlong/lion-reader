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

### Option 1: Connect to Hosted Lion Reader (Recommended)

Connect to your Lion Reader account at **lionreader.com** (or `localhost:3000` for local development):

#### Step 1: Create an API Token

1. Go to **lionreader.com/settings/integrations** (or `localhost:3000/settings/integrations`)
2. Click "Create API Token"
3. Name it "Claude Desktop" or "MCP"
4. Select scope: **`mcp`** (full MCP access)
5. Copy the token (you'll only see it once!)

#### Step 2: Configure Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "lion-reader": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch", "https://lionreader.com/api/mcp"],
      "env": {
        "AUTHORIZATION": "Bearer YOUR_API_TOKEN_HERE"
      }
    }
  }
}
```

For **local development**, use `http://localhost:3000/api/mcp` instead.

**Important:** Replace `YOUR_API_TOKEN_HERE` with the API token you created in Step 1.

#### Why This Approach?

- ✅ **No local server needed** - connects directly to lionreader.com
- ✅ **Secure** - uses OAuth-based API tokens with granular scopes
- ✅ **Same data** - works with your real Lion Reader account
- ✅ **Always up-to-date** - no need to keep local code in sync

---

### Option 2: Run Local MCP Server (Development)

For development or offline use, you can run a local MCP server:

```bash
# Start the MCP server (stdio transport)
pnpm mcp:serve
```

Configure Claude Desktop to use the local server:

```json
{
  "mcpServers": {
    "lion-reader-local": {
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

The hosted MCP endpoint (`/api/mcp`) uses **API tokens** with the `mcp` scope:

- Tokens are created in your Lion Reader account settings
- Passed via `Authorization: Bearer <token>` header
- Same system used by the browser extension
- Tokens can be revoked anytime from settings

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
