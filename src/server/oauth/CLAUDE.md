# OAuth 2.1 Server & MCP Auth (`src/server/oauth/`)

Covers `src/server/oauth/` plus the routes under `src/app/(spa)/oauth/`, `src/app/.well-known/` and `src/app/api/mcp/`. Security invariants: SECURITY.md §6. **Don't "simplify" anything here without re-testing Claude Desktop, Claude Code and `mcp-remote`.**

## claude.ai

claude.ai connectors, from the directory listing (`claude.ai/directory/lion-reader`) or added by URL, complete OAuth against the standard surface here. **We run no claude.ai-specific server workarounds**: a dedicated `mcp.*` host, root-path aliases, a `/register` method split and trailing-slash normalization were each tried against an upstream client bug (#986) and didn't help.

## Discovery

- **The resource identifier is the MCP endpoint URL** (`${issuer}/api/mcp`, `getResourceIdentifier()`), not the origin; `authorization_servers` is the origin.
- Protected-resource metadata is served at the **path-inserted** location (`/.well-known/oauth-protected-resource/api/mcp`), which is what the 401's `resource_metadata` points at, and also at the root. Authorization-server metadata is served at the root (authoritative) and the path-inserted location. Pointing `resource_metadata` at the root makes strict clients abort.
- The 401 `WWW-Authenticate` and JSON body copy the shape Linear/Sentry/Notion use. All OAuth/well-known documents are `Cache-Control: no-store`.

## Audience binding

- **Mint**: the requested `resource` must be one of the client's accepted identifiers (`invalid_target` otherwise); the token is bound to the canonical audience. The first-party app client (`app-client.ts`, resolved before the database and CIMD) is the only one bound to `${issuer}/api/v1`.
- **Refresh** preserves the grant's own audience — Wallabag shares the rotation path with a null audience, so never stamp the MCP identifier on rotation.
- **Use**: `/api/mcp` requires the canonical identifier (a null `resource` is accepted only on legacy tokens); the main API and SSE accept only `/api/v1` tokens, never null.

## Clients

- **CIMD** (an HTTPS URL as `client_id`): validation in `cimd.ts`, fetch and cache in `clients.ts`. **The fetch never follows redirects**, and the vendored pins cover **transport failures only**, never a withdrawn (404/410) or invalid document, which would defeat revocation. The advertising gate is at `client_id_metadata_document_supported` in `config.ts`.
- **Dynamic registration** is open by design (MCP clients register themselves; claude.ai does on every connect): never gate it behind an allowlist or initial access token. The consent screen is what stops a client posing as another (SECURITY.md §6). It stores only recognized scopes and rejects a registration with none (never falls back to "all scopes"). `SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS` (`utils.ts`) is the one list behind both the metadata and registration, so they can't disagree (strict clients abort on a mismatch).

## Revocation

Settings → Connected Apps (`oauthGrants`, session-only) revokes a `(user, client)` consent grant by deleting it, which cascades to every token grant under it (SECURITY.md §6). That **must close every path back in**: the code exchange refuses a code without it. Wallabag apps have no consent grant; they're signed out from their own settings section (`oauthGrants.revokeWallabag`) or by a password change.

## Rate limiting & CORS

The OAuth write endpoints use a generous per-IP `oauth` bucket, not `expensive`: claude.ai proxies them from a shared egress range and re-registers on every connect, so a strict bucket breaks legitimate connects. `.well-known/*` and `/api/mcp` aren't rate-limited (neither is expensive). These endpoints send CORS headers for in-browser MCP clients.
