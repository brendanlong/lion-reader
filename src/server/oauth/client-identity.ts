/**
 * How we identify an OAuth client to the user. A third-party client's name is
 * self-asserted (anyone can register one, or host a metadata document, called
 * "Claude"), so we show where its codes go. Only our own app and the clients
 * we vendor metadata for are verified, and not on a loopback redirect: any
 * local process can claim to be one of those.
 */

import { APP_CLIENT_ID } from "./app-client";
import { PINNED_CLIENT_METADATA } from "./cimd";
import { isLoopbackUrl } from "./utils";

const LOOPBACK_DESTINATION = "an app on this device";

function isVerifiedClient(clientId: string, redirectUris: readonly string[]): boolean {
  return (
    clientId === APP_CLIENT_ID ||
    (PINNED_CLIENT_METADATA.has(clientId) && redirectUris.some((uri) => !isLoopbackUrl(uri)))
  );
}

/** What the consent screen leads with instead of the client's name (null shows the name). */
export function consentClientIdentity(
  clientId: string,
  redirectUri: string
): { host: string | null; unverified: boolean } {
  if (clientId === APP_CLIENT_ID) {
    return { host: null, unverified: false };
  }
  return {
    host: isLoopbackUrl(redirectUri) ? LOOPBACK_DESTINATION : new URL(redirectUri).hostname,
    unverified: !isVerifiedClient(clientId, [redirectUri]),
  };
}

/**
 * Where an approved client's codes may have gone, for Connected Apps. We don't
 * record which redirect URI each authorization used, so this is every one the
 * client has.
 */
export function connectedAppDestinations(
  clientId: string,
  redirectUris: readonly string[]
): { redirectHosts: string[]; redirectsToLocalApp: boolean; unverified: boolean } {
  if (clientId === APP_CLIENT_ID) {
    return { redirectHosts: [], redirectsToLocalApp: false, unverified: false };
  }
  const remote = redirectUris.filter((uri) => !isLoopbackUrl(uri));
  return {
    redirectHosts: [...new Set(remote.map((uri) => new URL(uri).hostname))],
    redirectsToLocalApp: remote.length < redirectUris.length,
    unverified: !isVerifiedClient(clientId, redirectUris),
  };
}
