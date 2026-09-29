/**
 * The first-party native app's OAuth client.
 *
 * Defined in code rather than registered, and resolved ahead of the database
 * and CIMD so no registration can shadow it. It is the only client whose tokens
 * are minted for the main API audience (`getAppResourceIdentifier`); every other
 * client's tokens stay bound to `/api/mcp`. Dynamic registration lets any client
 * request any supported scope, so keying main-API access off a scope alone would
 * hand the reader API to any registered client after one consent click — the
 * audience is what pins it to this client.
 *
 * The redirect is an https URL on our own origin, claimed by the app as a
 * verified Android App Link (`/.well-known/assetlinks.json`), not a custom
 * scheme: any app can register a custom scheme and complete its own
 * authorization-code + PKCE flow under our client_id.
 */

import { getAcceptedResourceIdentifiers, getIssuer, getResourceIdentifier } from "./config";
import { OAUTH_SCOPES } from "./utils";

export const APP_CLIENT_ID = "lion-reader-app";

export function getAppRedirectUri(): string {
  return `${getIssuer()}/oauth/app-callback`;
}

/** The RFC 8707 audience of tokens accepted by the main tRPC/REST API. */
export function getAppResourceIdentifier(): string {
  return `${getIssuer()}/api/v1`;
}

export function getAppClient() {
  return {
    clientId: APP_CLIENT_ID,
    name: "Lion Reader app",
    redirectUris: [getAppRedirectUri()],
    grantTypes: ["authorization_code", "refresh_token"],
    scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
    isPublic: true,
    clientSecretHash: null,
    fromDatabase: false,
  };
}

/**
 * Resource indicators a client may request at `/oauth/authorize`. The app may
 * name the main API (or the bare origin); nobody else may.
 */
export function getAcceptedResourcesForClient(clientId: string): string[] {
  return clientId === APP_CLIENT_ID
    ? [getAppResourceIdentifier(), getIssuer()]
    : getAcceptedResourceIdentifiers();
}

/** The audience minted into a client's tokens, whatever alias it requested. */
export function getTokenAudienceForClient(clientId: string): string {
  return clientId === APP_CLIENT_ID ? getAppResourceIdentifier() : getResourceIdentifier();
}
