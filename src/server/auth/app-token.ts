/**
 * OAuth access tokens accepted by the main tRPC/REST API and the SSE endpoint.
 *
 * Only the first-party app's tokens qualify, and only when bound to the main-API
 * audience and holding `reader:full-access` — see `src/server/oauth/app-client.ts`
 * for why the audience, not the scope, is the gate. Every other OAuth token
 * (MCP clients, Wallabag) is rejected here exactly as if it were invalid.
 */

import { validateAccessToken, type OAuthTokenData } from "@/server/oauth/service";
import { APP_CLIENT_ID, getAppResourceIdentifier } from "@/server/oauth/app-client";
import { isResourceForThisServer, OAUTH_SCOPES } from "@/server/oauth/utils";

export async function validateAppAccessToken(token: string): Promise<OAuthTokenData | null> {
  const data = await validateAccessToken(token);
  if (
    !data ||
    data.clientId !== APP_CLIENT_ID ||
    data.resource === null ||
    !isResourceForThisServer(data.resource, getAppResourceIdentifier()) ||
    !data.scopes.includes(OAUTH_SCOPES.READER_FULL_ACCESS)
  ) {
    return null;
  }
  return data;
}
