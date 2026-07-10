/**
 * Trailing-slash normalization for the OAuth/MCP surface, applied in the
 * custom HTTP server (scripts/server.ts) before Next.js sees the request.
 *
 * Next's default behavior is a blanket 308 redirect (`/foo/` → `/foo`), which
 * is right for the site but wrong for OAuth/MCP endpoints: server-to-server
 * OAuth clients (claude.ai's connector uses python-httpx) don't follow
 * redirects on POST, and claude.ai has been observed appending trailing
 * slashes (anthropics/claude-ai-mcp#324). The known-working remote MCP servers
 * (Linear, Sentry, Notion) all answer `POST /mcp/` in place.
 *
 * Rewriting `req.url` here — rather than `skipTrailingSlashRedirect` plus
 * middleware — keeps the change scoped to exactly these paths: Next's built-in
 * redirect stays in force for every other URL, and there is no site-wide
 * dependency on middleware coverage (an unmatched slashed path under
 * `skipTrailingSlashRedirect` is served a broken empty 200, so that approach
 * put the whole site one matcher gap away from breakage).
 *
 * `/register` is deliberately NOT normalized: claude.ai POSTs its root-path
 * DCR to `/register` without a slash (see src/proxy.ts), and `GET /register/`
 * should keep redirecting to the signup page like any other page URL.
 */

/**
 * True for the (slash-trimmed) paths that must answer slashed URLs in place.
 */
export function isOauthMcpSurfacePath(pathname: string): boolean {
  return (
    pathname === "/api/mcp" ||
    pathname === "/token" ||
    pathname === "/authorize" ||
    pathname.startsWith("/oauth/") ||
    pathname.startsWith("/.well-known/")
  );
}

/**
 * Strips trailing slashes from `req.url` (raw path + optional query string)
 * when — and only when — the trimmed path is on the OAuth/MCP surface.
 * Everything else is returned unchanged, leaving Next's built-in
 * trailing-slash redirect to handle it.
 *
 * Operates on the raw (still percent-encoded) URL, so an encoded slash
 * (`%2F`) never triggers normalization.
 */
export function stripOauthSurfaceTrailingSlash(reqUrl: string): string {
  const queryIndex = reqUrl.indexOf("?");
  const pathname = queryIndex === -1 ? reqUrl : reqUrl.slice(0, queryIndex);
  if (pathname.length <= 1 || !pathname.endsWith("/")) {
    return reqUrl;
  }
  const trimmed = pathname.replace(/\/+$/, "");
  if (!isOauthMcpSurfacePath(trimmed)) {
    return reqUrl;
  }
  return queryIndex === -1 ? trimmed : trimmed + reqUrl.slice(queryIndex);
}
