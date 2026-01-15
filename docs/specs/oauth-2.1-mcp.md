# OAuth 2.1 Implementation for MCP Compliance

**Status:** Specification
**Priority:** P2 (Future Enhancement)
**Created:** 2026-01-15
**Owner:** Backend Team

## Overview

This document specifies the full OAuth 2.1 authorization server implementation required for MCP (Model Context Protocol) compliance. The current implementation uses Bearer token authentication (API tokens), which works but doesn't conform to the MCP specification's OAuth 2.1 requirements.

## Current State

### What Works Today

✅ **Bearer Token Authentication** (`/api/mcp` endpoint)

- API tokens with scopes (`mcp`, `saved:write`)
- Token creation via `/settings/api-tokens`
- Token validation and revocation
- Secure token storage (SHA-256 hashing)

✅ **MCP Server** (HTTP transport)

- 9 MCP tools for entries and subscriptions
- Automatic `userId` injection from token
- Services layer for shared business logic
- JSON-RPC 2.0 over HTTP

### What's Missing for MCP Compliance

❌ **OAuth 2.1 Authorization Flow**

- Users must manually create tokens in settings
- No standard OAuth authorization code flow
- No PKCE (Proof Key for Code Exchange)
- No OAuth discovery endpoints

❌ **Client Registration**

- No dynamic client registration
- No Client ID Metadata Documents support
- Manual client management only

## MCP Specification Requirements

The [MCP Authorization Specification](https://modelcontextprotocol.io/docs/specification/2024-11-05/authorization) requires:

### 1. OAuth 2.1 Core ([RFC Draft](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13))

- ✅ REQUIRED: Authorization Code flow
- ✅ REQUIRED: PKCE (RFC 7636) with S256 challenge method
- ✅ REQUIRED: Refresh token rotation
- ✅ REQUIRED: HTTPS for all endpoints (except localhost)

### 2. Resource Indicators ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html))

- ✅ REQUIRED: `resource` parameter in authorize/token requests
- ✅ REQUIRED: Token audience validation
- ✅ FORBIDDEN: Token passthrough to other services

### 3. Discovery Mechanisms

- ✅ REQUIRED: OAuth 2.0 Protected Resource Metadata (RFC 9728)
- ✅ REQUIRED: Authorization Server Metadata (RFC 8414) OR OpenID Connect Discovery
- ✅ REQUIRED: `WWW-Authenticate` header with `resource_metadata` on 401

### 4. Client Registration

- ✅ RECOMMENDED: Client ID Metadata Documents (OAuth draft)
- ✅ OPTIONAL: Dynamic Client Registration (RFC 7591)
- ✅ OPTIONAL: Pre-registration

## Proposed Architecture

### Database Schema

```typescript
// OAuth clients (Claude Desktop, other MCP clients)
oauth_clients {
  id: uuid PRIMARY KEY
  client_id: text UNIQUE NOT NULL  // URL for CIMD, or custom ID
  client_secret_hash: text         // NULL for public clients
  name: text NOT NULL
  redirect_uris: text[] NOT NULL   // Allowed redirect URIs
  grant_types: text[] NOT NULL     // ['authorization_code', 'refresh_token']
  scopes: text[]                   // Available scopes for this client
  is_public: boolean NOT NULL      // PKCE required for public clients
  metadata_url: text               // For Client ID Metadata Documents
  created_at: timestamptz NOT NULL
  updated_at: timestamptz NOT NULL
}

// Short-lived authorization codes (~10 minutes)
oauth_authorization_codes {
  id: uuid PRIMARY KEY
  code: text UNIQUE NOT NULL       // Random code
  client_id: uuid NOT NULL REFERENCES oauth_clients(id)
  user_id: uuid NOT NULL REFERENCES users(id)
  redirect_uri: text NOT NULL      // Must match client's registered URIs
  scope: text[] NOT NULL
  code_challenge: text NOT NULL    // PKCE S256 hash
  code_challenge_method: text NOT NULL  // 'S256'
  used_at: timestamptz             // Codes are single-use
  created_at: timestamptz NOT NULL
  expires_at: timestamptz NOT NULL
}

// Access tokens (short-lived, ~1 hour)
oauth_access_tokens {
  id: uuid PRIMARY KEY
  token_hash: text UNIQUE NOT NULL
  client_id: uuid NOT NULL REFERENCES oauth_clients(id)
  user_id: uuid NOT NULL REFERENCES users(id)
  scope: text[] NOT NULL
  resource: text                   // RFC 8707 audience
  created_at: timestamptz NOT NULL
  expires_at: timestamptz NOT NULL
  revoked_at: timestamptz
  last_used_at: timestamptz
}

// Refresh tokens (longer-lived, ~30 days, with rotation)
oauth_refresh_tokens {
  id: uuid PRIMARY KEY
  token_hash: text UNIQUE NOT NULL
  client_id: uuid NOT NULL REFERENCES oauth_clients(id)
  user_id: uuid NOT NULL REFERENCES users(id)
  scope: text[] NOT NULL
  access_token_id: uuid REFERENCES oauth_access_tokens(id)
  created_at: timestamptz NOT NULL
  expires_at: timestamptz NOT NULL
  revoked_at: timestamptz
  replaced_by: uuid REFERENCES oauth_refresh_tokens(id)  // Token rotation
}
```

### OAuth Endpoints (Next.js API Routes)

#### 1. Discovery Endpoints

**`GET /.well-known/oauth-authorization-server`**

```json
{
  "issuer": "https://lionreader.com",
  "authorization_endpoint": "https://lionreader.com/oauth/authorize",
  "token_endpoint": "https://lionreader.com/oauth/token",
  "scopes_supported": ["mcp", "saved:write"],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_basic"],
  "client_id_metadata_document_supported": true
}
```

**`GET /.well-known/oauth-protected-resource`**

```json
{
  "resource": "https://lionreader.com",
  "authorization_servers": ["https://lionreader.com"],
  "scopes_supported": ["mcp", "saved:write"],
  "bearer_methods_supported": ["header"]
}
```

#### 2. Authorization Endpoint

**`GET/POST /oauth/authorize`**

Parameters:

- `response_type=code` (required)
- `client_id` (required) - URL for CIMD or registered ID
- `redirect_uri` (required) - Must match registered URI
- `scope` (optional) - Space-separated scopes
- `state` (recommended) - Client state for CSRF protection
- `code_challenge` (required) - PKCE S256 hash
- `code_challenge_method=S256` (required)
- `resource` (required) - Canonical MCP server URI

Flow:

1. Validate `client_id` (fetch CIMD if URL, or lookup in DB)
2. Validate `redirect_uri` matches client's registered URIs
3. Validate PKCE parameters
4. Check if user is authenticated (use existing NextAuth session)
5. If not authenticated → redirect to `/login?redirect=/oauth/authorize?...`
6. If authenticated → show consent screen
7. User approves → generate authorization code
8. Redirect to `redirect_uri` with `code` and `state`

#### 3. Token Endpoint

**`POST /oauth/token`**

For authorization code exchange:

```json
{
  "grant_type": "authorization_code",
  "code": "...",
  "redirect_uri": "...",
  "client_id": "...",
  "code_verifier": "...", // PKCE verifier
  "resource": "https://lionreader.com"
}
```

For refresh token:

```json
{
  "grant_type": "refresh_token",
  "refresh_token": "...",
  "client_id": "...",
  "resource": "https://lionreader.com"
}
```

Response:

```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "...",
  "scope": "mcp"
}
```

Flow:

1. Validate grant type
2. For `authorization_code`:
   - Retrieve code from DB
   - Verify code not expired/used
   - Verify PKCE: hash(code_verifier) === code_challenge
   - Verify redirect_uri matches
   - Mark code as used
   - Generate access + refresh tokens
3. For `refresh_token`:
   - Retrieve refresh token from DB
   - Verify not expired/revoked
   - Revoke old refresh token
   - Generate new access + refresh tokens (rotation)
4. Return tokens

### UI Components

#### 1. OAuth Consent Screen (`/oauth/consent`)

```tsx
<ConsentScreen>
  <h1>Authorize Application</h1>
  <p>{clientName} wants to access your Lion Reader account</p>

  <ScopeList>
    {scopes.map((scope) => (
      <ScopeItem key={scope}>
        <Icon /> {scopeLabels[scope]}
      </ScopeItem>
    ))}
  </ScopeList>

  <Warning>Only authorize applications you trust</Warning>

  <Actions>
    <Button onClick={approve}>Authorize</Button>
    <Button variant="ghost" onClick={deny}>
      Deny
    </Button>
  </Actions>
</ConsentScreen>
```

#### 2. OAuth Client Management (Optional)

Settings page at `/settings/oauth-clients` for users to:

- View connected applications
- Revoke access tokens
- See last used dates
- Manage consent grants

### Library Integration: @node-oauth/oauth2-server

Use the [@node-oauth/oauth2-server](https://github.com/node-oauth/node-oauth2-server) library for OAuth 2.0/2.1 implementation.

**Install:**

```bash
pnpm add @node-oauth/oauth2-server
```

**Model Interface** (required methods):

```typescript
import OAuth2Server from "@node-oauth/oauth2-server";
import { db } from "@/server/db";
import { oauthClients, oauthAuthorizationCodes, oauthAccessTokens } from "@/server/db/schema";

const model: OAuth2Server.AuthorizationCodeModel = {
  // Client management
  async getClient(clientId, clientSecret) {
    // If clientId is a URL, fetch Client ID Metadata Document
    if (clientId.startsWith("https://")) {
      const metadata = await fetch(clientId).then((r) => r.json());
      return {
        id: metadata.client_id,
        redirectUris: metadata.redirect_uris,
        grants: metadata.grant_types,
      };
    }

    // Otherwise look up in database
    const client = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);

    if (!client[0]) return null;

    // Verify secret for confidential clients
    if (clientSecret) {
      // Hash and compare clientSecret
    }

    return {
      id: client[0].clientId,
      redirectUris: client[0].redirectUris,
      grants: client[0].grantTypes,
    };
  },

  // Authorization code management
  async saveAuthorizationCode(code, client, user) {
    await db.insert(oauthAuthorizationCodes).values({
      id: generateUuidv7(),
      code: code.authorizationCode,
      clientId: client.id,
      userId: user.id,
      redirectUri: code.redirectUri,
      scope: code.scope,
      codeChallenge: code.codeChallenge, // PKCE
      codeChallengeMethod: code.codeChallengeMethod,
      expiresAt: code.expiresAt,
      createdAt: new Date(),
    });

    return { ...code, client, user };
  },

  async getAuthorizationCode(authorizationCode) {
    const code = await db
      .select()
      .from(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.code, authorizationCode))
      .limit(1);

    if (!code[0] || code[0].usedAt || code[0].expiresAt < new Date()) {
      return null;
    }

    // Return with client and user objects
    return {
      authorizationCode: code[0].code,
      expiresAt: code[0].expiresAt,
      redirectUri: code[0].redirectUri,
      scope: code[0].scope,
      codeChallenge: code[0].codeChallenge,
      codeChallengeMethod: code[0].codeChallengeMethod,
      client: { id: code[0].clientId },
      user: { id: code[0].userId },
    };
  },

  async revokeAuthorizationCode(code) {
    await db
      .update(oauthAuthorizationCodes)
      .set({ usedAt: new Date() })
      .where(eq(oauthAuthorizationCodes.code, code.authorizationCode));
    return true;
  },

  // Token management
  async saveToken(token, client, user) {
    const accessTokenId = generateUuidv7();
    const refreshTokenId = generateUuidv7();

    await db.insert(oauthAccessTokens).values({
      id: accessTokenId,
      tokenHash: hashToken(token.accessToken),
      clientId: client.id,
      userId: user.id,
      scope: token.scope,
      resource: token.resource, // RFC 8707
      expiresAt: token.accessTokenExpiresAt,
      createdAt: new Date(),
    });

    await db.insert(oauthRefreshTokens).values({
      id: refreshTokenId,
      tokenHash: hashToken(token.refreshToken),
      clientId: client.id,
      userId: user.id,
      scope: token.scope,
      accessTokenId,
      expiresAt: token.refreshTokenExpiresAt,
      createdAt: new Date(),
    });

    return { ...token, client, user };
  },

  async getAccessToken(accessToken) {
    const token = await db
      .select()
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.tokenHash, hashToken(accessToken)))
      .limit(1);

    if (!token[0] || token[0].expiresAt < new Date() || token[0].revokedAt) {
      return null;
    }

    return {
      accessToken: token[0].tokenHash,
      accessTokenExpiresAt: token[0].expiresAt,
      scope: token[0].scope,
      client: { id: token[0].clientId },
      user: { id: token[0].userId },
    };
  },

  async getRefreshToken(refreshToken) {
    // Similar to getAccessToken
  },

  async revokeToken(token) {
    // Revoke refresh token (for rotation)
    await db
      .update(oauthRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oauthRefreshTokens.tokenHash, hashToken(token.refreshToken)));
    return true;
  },

  // Scope validation
  async validateScope(user, client, scope) {
    // Verify requested scopes are allowed for this client
    const allowedScopes = client.scopes || ["mcp", "saved:write"];
    return scope.filter((s) => allowedScopes.includes(s));
  },
};

export const oauth2Server = new OAuth2Server({ model });
```

**Usage in API Routes:**

```typescript
// app/oauth/authorize/route.ts
import { oauth2Server } from "@/server/oauth/server";

export async function GET(request: NextRequest) {
  const req = convertToOAuth2Request(request);
  const res = convertToOAuth2Response();

  try {
    const code = await oauth2Server.authorize(req, res, {
      authenticateHandler: {
        handle: async () => {
          // Return user from NextAuth session
          return getCurrentUser(request);
        },
      },
    });

    // Redirect to redirect_uri with code
    return NextResponse.redirect(code.redirectUri);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

// app/oauth/token/route.ts
export async function POST(request: NextRequest) {
  const req = convertToOAuth2Request(request);
  const res = convertToOAuth2Response();

  try {
    const token = await oauth2Server.token(req, res);
    return NextResponse.json(token);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
```

### Integration with Existing Systems

#### 1. NextAuth Integration

- **Authentication:** Use existing NextAuth session for user authentication
- **Authorization:** New OAuth consent flow sits on top
- **Sessions:** Keep existing session management
- **API Tokens:** Keep for backward compatibility with browser extension

#### 2. MCP Endpoint Updates

**Current (`/api/mcp`):**

```typescript
async function authenticateRequest(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.slice(7); // "Bearer "

  const tokenData = await validateApiToken(token); // Current system
  return tokenData?.user.id;
}
```

**Updated (support both):**

```typescript
async function authenticateRequest(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.slice(7);

  // Try OAuth access token first
  const oauthToken = await validateOAuthAccessToken(token);
  if (oauthToken) return oauthToken.userId;

  // Fall back to API token (for backward compatibility)
  const apiToken = await validateApiToken(token);
  return apiToken?.user.id;
}
```

#### 3. Backward Compatibility

Keep existing API token system for:

- Browser extension (`saved:write` scope)
- Existing integrations
- Development/testing

Users can choose:

- **API Tokens:** Manual creation in settings (current system)
- **OAuth 2.1:** Standard authorization flow (new system)

## Implementation Plan

### Phase 1: Database & Core OAuth (Week 1-2)

- [ ] Create database migration for OAuth tables
- [ ] Install @node-oauth/oauth2-server
- [ ] Implement OAuth model interface
- [ ] Create OAuth2Server instance
- [ ] Add token hashing utilities

### Phase 2: Authorization Flow (Week 3-4)

- [ ] Implement `/oauth/authorize` endpoint
- [ ] Create consent screen UI
- [ ] Integrate with NextAuth session
- [ ] Handle PKCE validation
- [ ] Add error handling

### Phase 3: Token Flow (Week 5)

- [ ] Implement `/oauth/token` endpoint
- [ ] Add authorization code exchange
- [ ] Add refresh token rotation
- [ ] Validate `resource` parameter (RFC 8707)
- [ ] Add token revocation

### Phase 4: Discovery (Week 6)

- [ ] Implement `/.well-known/oauth-authorization-server`
- [ ] Implement `/.well-known/oauth-protected-resource`
- [ ] Add `WWW-Authenticate` header to 401 responses
- [ ] Test with MCP specification compliance

### Phase 5: Client Registration (Week 7)

- [ ] Implement Client ID Metadata Documents support
- [ ] Add client validation from HTTPS URLs
- [ ] Optional: Dynamic client registration endpoint
- [ ] Add client management UI

### Phase 6: MCP Integration (Week 8)

- [ ] Update MCP endpoint to accept OAuth tokens
- [ ] Maintain backward compatibility with API tokens
- [ ] Update MCP README documentation
- [ ] Test with Claude Desktop

### Phase 7: Testing & Documentation (Week 9-10)

- [ ] Write integration tests for OAuth flow
- [ ] Test PKCE validation
- [ ] Test token rotation
- [ ] Test with real MCP clients
- [ ] Update user documentation
- [ ] Create migration guide

## Security Considerations

### 1. PKCE Enforcement

- ✅ REQUIRED for all public clients
- ✅ REQUIRED S256 challenge method
- ❌ FORBIDDEN plain challenge method

### 2. Token Security

- ✅ Store token hashes, never raw tokens
- ✅ Use SHA-256 for token hashing
- ✅ Short-lived access tokens (~1 hour)
- ✅ Refresh token rotation
- ✅ Revoke refresh token chain on suspicious activity

### 3. Client Validation

- ✅ Exact redirect URI matching
- ✅ HTTPS required for redirect URIs (except localhost)
- ✅ Client ID Metadata Document validation
- ✅ Cache metadata with HTTP cache headers
- ❌ FORBIDDEN wildcard redirect URIs

### 4. Resource Indicators

- ✅ Validate `resource` parameter matches MCP server
- ✅ Include audience in token validation
- ❌ FORBIDDEN token passthrough to other services

### 5. State Parameter

- ✅ RECOMMENDED for CSRF protection
- ✅ Client should validate state matches

## Testing Strategy

### Unit Tests

- OAuth model methods (getClient, saveToken, etc.)
- PKCE challenge/verifier validation
- Token hashing and validation
- Scope validation logic

### Integration Tests

- Full authorization code flow
- Token exchange with PKCE
- Refresh token rotation
- Token revocation
- Invalid code/token handling
- Expired token handling
- Client ID Metadata Document fetching

### End-to-End Tests

- Claude Desktop connection flow
- Browser extension OAuth flow (if supported)
- Token expiration and refresh
- Multi-client scenarios
- Revocation scenarios

### MCP Compliance Tests

- Test against MCP specification examples
- Validate discovery endpoints
- Test WWW-Authenticate headers
- Verify resource parameter handling
- Test PKCE S256 enforcement

## Migration Path

### For Existing Users

**Option 1: Gradual Migration**

1. Keep existing API token system
2. Add OAuth alongside
3. Encourage OAuth for new integrations
4. Eventually deprecate API tokens

**Option 2: Automatic Migration**

1. Generate OAuth client for each API token
2. Auto-approve consent for existing tokens
3. Phase out API tokens after N months

### For New Users

- Default to OAuth 2.1 flow
- Guide users through authorization in Claude Desktop
- Optionally show API token creation for advanced users

## Documentation Requirements

### User Documentation

- [ ] "Connecting Claude Desktop" guide
- [ ] OAuth vs API tokens comparison
- [ ] Troubleshooting guide
- [ ] Security best practices
- [ ] Revoking access guide

### Developer Documentation

- [ ] OAuth 2.1 implementation architecture
- [ ] API endpoint specifications
- [ ] Model interface documentation
- [ ] Testing guide
- [ ] Integration patterns

## Success Criteria

✅ **MCP Specification Compliance**

- Passes all required OAuth 2.1 checks
- Implements PKCE with S256
- Supports Client ID Metadata Documents
- Provides discovery endpoints
- Validates resource parameters

✅ **User Experience**

- Users can connect Claude Desktop without manual token creation
- Standard OAuth flow familiar to users
- Clear consent screen
- Easy revocation process

✅ **Security**

- No token storage vulnerabilities
- PKCE prevents code interception
- Token rotation prevents replay attacks
- Audience validation prevents token misuse

✅ **Compatibility**

- Works with Claude Desktop
- Works with other MCP clients
- Maintains backward compatibility with API tokens
- Integrates seamlessly with existing auth system

## References

- [MCP Authorization Specification](https://modelcontextprotocol.io/docs/specification/2024-11-05/authorization)
- [OAuth 2.1 Draft](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13)
- [RFC 7636 - PKCE](https://datatracker.ietf.org/doc/html/rfc7636)
- [RFC 8707 - Resource Indicators](https://www.rfc-editor.org/rfc/rfc8707.html)
- [RFC 9728 - Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
- [RFC 8414 - Authorization Server Metadata](https://datatracker.ietf.org/doc/html/rfc8414)
- [@node-oauth/oauth2-server](https://github.com/node-oauth/oauth2-server)
- [@node-oauth/oauth2-server Documentation](https://node-oauthoauth2-server.readthedocs.io/)

## Questions & Decisions

### Q: Should we deprecate API tokens?

**A:** No, keep both systems:

- **OAuth 2.1:** Primary for MCP clients (Claude Desktop)
- **API Tokens:** Backup for simple integrations, development, browser extension

### Q: Should we implement dynamic client registration?

**A:** Optional, Phase 2 feature:

- Start with Client ID Metadata Documents (recommended by MCP spec)
- Add dynamic registration if users request it
- Pre-registration for internal clients

### Q: How do we handle consent?

**A:** Show consent screen on first authorization:

- Display client name and requested scopes
- Remember consent (don't ask every time)
- Allow users to revoke in settings
- Re-prompt if scopes change

### Q: Token lifetimes?

**A:** Follow OAuth best practices:

- **Access tokens:** 1 hour (short-lived)
- **Refresh tokens:** 30 days (with rotation)
- **Authorization codes:** 10 minutes

### Q: Scope design?

**A:** Start simple, expand as needed:

- `mcp` - Full MCP access (read/write entries, subscriptions)
- `mcp:read` - Read-only MCP access (future)
- `saved:write` - Create saved articles (browser extension)
- Additional granular scopes as requested

---

**Next Steps:**

1. Review this specification with team
2. Get approval for implementation timeline
3. Create JIRA tickets for each phase
4. Begin Phase 1: Database & Core OAuth
