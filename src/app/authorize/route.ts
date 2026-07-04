/**
 * Root-level OAuth authorization endpoint alias (`/authorize`).
 *
 * claude.ai's connector synthesizes OAuth endpoints at the origin ROOT
 * (`/authorize`, `/token`) instead of using the `authorization_endpoint` /
 * `token_endpoint` advertised in our RFC 8414 authorization-server metadata.
 * Observed with a manually-configured client_id: claude.ai redirected the
 * browser to `https://lionreader.com/authorize` (404) rather than the advertised
 * `/oauth/authorize`. This is a known claude.ai behavior — see
 * anthropics/claude-ai-mcp #82, #341, #78 and the wiki failure catalog.
 *
 * We re-export the real handlers here so the flow completes at the root path.
 * `/oauth/authorize` remains for spec-compliant clients (mcp-remote, Inspector),
 * which correctly follow the advertised metadata.
 */
export { GET, POST } from "@/app/oauth/authorize/route";
