/**
 * Authentication for route handlers outside tRPC that stream: the same credentials the tRPC context takes from
 * a browser or the first-party app — a session (cookie or Bearer) or the app's
 * OAuth access token.
 */

import { isSignupConfirmed } from "@/server/auth/confirmation";
import { authenticateCredential, getBearerOrSessionCookie } from "@/server/auth/credential";
import { isSessionActive } from "@/server/auth/session";
import { isAccessTokenActive } from "@/server/oauth/service";
import { trackAndroidAppRequest } from "@/server/metrics/metrics";

export interface RouteAuth {
  userId: string;
  credential: "session" | "app-token";
  /** Whether the user has completed signup confirmation (ToS, privacy, EU). */
  confirmed: boolean;
  /** Whether the credential is still valid, for streams that outlive the request. */
  isCredentialActive: () => Promise<boolean>;
}

/** The request's user, or null when it has no valid credential. */
export async function authenticateRouteRequest(headers: Headers): Promise<RouteAuth | null> {
  const auth = await authenticateCredential(getBearerOrSessionCookie(headers), {
    accept: ["session", "app_token"],
  });
  if (!auth.ok) return null;

  const { credential } = auth;
  const base = { userId: credential.user.id, confirmed: isSignupConfirmed(credential.user) };
  if (credential.kind === "session") {
    const sessionId = credential.session.session.id;
    return { ...base, credential: "session", isCredentialActive: () => isSessionActive(sessionId) };
  }
  trackAndroidAppRequest(headers.get("user-agent"));
  const tokenId = credential.oauthToken.tokenId;
  return {
    ...base,
    credential: "app-token",
    isCredentialActive: () => isAccessTokenActive(tokenId),
  };
}
