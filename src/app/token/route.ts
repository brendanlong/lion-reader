/**
 * Root-level OAuth token endpoint alias (`/token`).
 *
 * See `src/app/authorize/route.ts`: claude.ai synthesizes OAuth endpoints at the
 * origin root and ignores the advertised `token_endpoint`. It POSTs the code
 * exchange to `https://lionreader.com/token`, so we serve the real token handler
 * here. `/oauth/token` remains for spec-compliant clients.
 */
export { POST, OPTIONS } from "@/app/oauth/token/route";
