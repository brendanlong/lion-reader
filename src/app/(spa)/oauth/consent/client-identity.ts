import { cimdClientHost } from "@/server/oauth/cimd";
import { isLoopbackUrl } from "@/server/oauth/utils";

export interface ConsentClientIdentity {
  /** What the consent screen leads with instead of the self-asserted name; null shows the name. */
  host: string | null;
  unverified: boolean;
}

const LOOPBACK_DESTINATION = "an app on this device";

/**
 * Anyone can register a client with any name, so a registered client is
 * unverified and is identified by where its code will be sent: otherwise a
 * client named "Claude" with an attacker's redirect URI reads as Claude.
 */
export function consentClientIdentity(
  clientId: string,
  client: { fromDatabase: boolean },
  redirectUri: string
): ConsentClientIdentity {
  if (!client.fromDatabase) {
    return { host: cimdClientHost(clientId, client), unverified: false };
  }
  return {
    host: isLoopbackUrl(redirectUri) ? LOOPBACK_DESTINATION : new URL(redirectUri).hostname,
    unverified: true,
  };
}
