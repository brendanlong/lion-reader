# Authentication & Authorization (`src/server/auth/`)

The security invariants for this directory are in SECURITY.md §4–5; the OAuth 2.1 **server** is `src/server/oauth/CLAUDE.md`. Mechanics are documented where they live (`session.ts`, `session-cookie.ts`, `oauth/*.ts`, `src/server/rate-limit/`).

## Sessions

- **The server is the session cookie's only writer**; there is no client-side token management. Browser tRPC mutations set and clear it through the fetch adapter's `resHeaders` (a no-op on the REST/OpenAPI surface, whose clients use the token in the response body); the OAuth redirect routes set it on the redirect response.
- **The client never inspects the cookie.** `<AuthErrorHandler>` is mounted only on authenticated surfaces, so any `UNAUTHORIZED` there means the session died. Don't mount it on auth, `/save` or `/demo` pages, whose 401s are expected.
- A **scoped session** (`scopes IS NOT NULL`, the Google Reader `ClientLogin` token) is rejected for full-access use unless the caller passes `allowScoped: true` and checks the scope itself (only the Google Reader API does). It doesn't count as user activity (`updateLastActiveAt` says why).

## Social login (OAuth client)

- **Sign-in and linking share one callback route** but are different flows, distinguished by the Redis state blob. Sign-in picks the account by verified provider email; a link carries an `OAuthLinkTarget` captured up front and never decides the account by email. **A link that can't be honoured is an error, never a fallthrough to sign-in** — that fallthrough created a second, empty account (#1603).
- Provider metadata is hard-coded, and all three providers use `client_secret_post` (`oauth/config.ts` says why; don't "tidy" it to Basic).

## Token scopes

Credential types: browser sessions (full access), scoped sessions, API tokens (`api_tokens`, limited to their scopes), and OAuth 2.1 access tokens (audience-bound, `src/server/oauth/CLAUDE.md`; the native app's arrive as `authType: "app_token"`, and on the streaming routes through `route-auth.ts`).

Scopes are `mcp`, `saved:write`, and `reader:full-access` (OAuth/session only: the reader surface minus account settings, minted for the Wallabag and Google Reader compat APIs and the native app).

- `protectedProcedure`, `confirmedProtectedProcedure` and their `expensive*` variants are **session-only**. **A new endpoint is token-inaccessible until it opts in** with `scopedProtectedProcedure(scopes)`, where a token must hold one of the scopes (`expensiveScopedProtectedProcedure` adds the rate limit).
- Which set to opt into: `READER_SCOPES` for the MCP tools' tRPC counterparts (which the native app also uses), `reader:full-access` alone for app-only endpoints, `SAVE_ARTICLE_SCOPES` (+ `reader:full-access`) for saving (`src/server/auth/api-token.ts`).
- `/api/mcp` requires signup confirmation for both OAuth and API tokens, like `confirmedProtectedProcedure`.

## Rate limiting

Ordinary limits fail open when Redis is down. The **per-account password bucket** (shared by tRPC login, Google Reader `ClientLogin`, and the Wallabag password grant, keyed by normalized email and consumed before the user lookup) falls back to a bounded in-memory bucket instead, since brute-force protection must not vanish while degraded. `/oauth/token` takes no password and uses the `oauth` bucket.
