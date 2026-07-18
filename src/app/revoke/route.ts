/**
 * Root-level OAuth revocation endpoint alias (`/revoke`).
 *
 * On the dedicated MCP host (`mcpConfig.host`) the authorization-server metadata
 * advertises all OAuth endpoints at the origin root (see
 * `getAuthorizationServerMetadata`), including `revocation_endpoint`, so the
 * revocation handler must answer at `/revoke` for that advertisement to be
 * truthful. Served on every host like the other root aliases
 * (src/app/{authorize,token}/route.ts); `/oauth/revoke` remains the advertised
 * path on the apex.
 *
 * NOTE: route-segment config does NOT propagate through `export { … } from`
 * (see src/app/authorize/route.ts). `/oauth/revoke` declares none today; mirror
 * it here if that ever changes.
 */
export { POST, OPTIONS } from "@/app/(spa)/oauth/revoke/route";
