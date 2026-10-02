/**
 * Authentication for route handlers outside tRPC that stream (`/api/v1/events`,
 * `/api/v1/narration/speech`): the same credentials the tRPC context takes from
 * a browser or the first-party app — a session (cookie or Bearer) or the app's
 * OAuth access token.
 */

import { extractBearerToken } from "@/server/auth/bearer";
import { isSignupConfirmed } from "@/server/auth/confirmation";
import { validateAppAccessToken } from "@/server/auth/app-token";
import { isSessionActive, validateSession } from "@/server/auth/session";
import { isAccessTokenActive } from "@/server/oauth/service";

export interface RouteAuth {
  userId: string;
  credential: "session" | "app-token";
  /** Whether the user has completed signup confirmation (ToS, privacy, EU). */
  confirmed: boolean;
  /** Whether the credential is still valid, for streams that outlive the request. */
  isCredentialActive: () => Promise<boolean>;
}

function getCredential(headers: Headers): string | null {
  const bearerToken = extractBearerToken(headers.get("authorization"));
  if (bearerToken) return bearerToken;

  const cookieHeader = headers.get("cookie");
  if (!cookieHeader) return null;
  const cookies = Object.fromEntries(
    cookieHeader.split("; ").map((c) => {
      const [key, ...value] = c.split("=");
      return [key, value.join("=")];
    })
  );
  return cookies.session ?? null;
}

/** The request's user, or null when it has no valid credential. */
export async function authenticateRouteRequest(headers: Headers): Promise<RouteAuth | null> {
  const credential = getCredential(headers);
  if (!credential) return null;

  const sessionData = await validateSession(credential);
  if (sessionData) {
    const sessionId = sessionData.session.id;
    return {
      userId: sessionData.user.id,
      credential: "session",
      confirmed: isSignupConfirmed(sessionData.user),
      isCredentialActive: () => isSessionActive(sessionId),
    };
  }

  const appToken = await validateAppAccessToken(credential);
  if (!appToken) return null;
  const tokenId = appToken.tokenId;
  return {
    userId: appToken.userId,
    credential: "app-token",
    confirmed: isSignupConfirmed(appToken.user),
    isCredentialActive: () => isAccessTokenActive(tokenId),
  };
}
