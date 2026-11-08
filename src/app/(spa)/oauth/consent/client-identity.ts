import { APP_CLIENT_ID } from "@/server/oauth/app-client";
import { PINNED_CLIENT_METADATA } from "@/server/oauth/cimd";
import { isLoopbackUrl } from "@/server/oauth/utils";

const LOOPBACK_DESTINATION = "an app on this device";

/**
 * What the consent screen identifies a client by. A third-party client's name
 * is self-asserted (anyone can register one, or host a metadata document,
 * called "Claude"), so it leads with the host the code will be sent to, which
 * is what consent covers (`hasConsent`). Only our own app and the clients we
 * vendor metadata for are verified.
 */
export function consentClientIdentity(
  clientId: string,
  redirectUri: string
): { host: string | null; unverified: boolean } {
  if (clientId === APP_CLIENT_ID) {
    return { host: null, unverified: false };
  }
  return {
    host: isLoopbackUrl(redirectUri) ? LOOPBACK_DESTINATION : new URL(redirectUri).hostname,
    unverified: !PINNED_CLIENT_METADATA.has(clientId),
  };
}
