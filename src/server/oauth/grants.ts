/**
 * OAuth consent grants: recording and checking a user's consent to a client,
 * and the Settings → Connected Apps listing and revocation.
 */

import { eq, and, isNull, desc, max } from "drizzle-orm";
import { db, type DbOrTx } from "@/server/db";
import {
  oauthClients,
  oauthAuthorizationCodes,
  oauthAccessTokens,
  oauthRefreshTokens,
  oauthConsentGrants,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { APP_CLIENT_ID, getAppClient } from "./app-client";
import { cimdClientHost } from "./cimd";
import { logger } from "@/lib/logger";

/**
 * Checks if user has already consented to the client with required scopes.
 * An empty `scopes` asks only whether an active grant exists.
 */
export async function hasConsent(
  userId: string,
  clientId: string,
  scopes: string[],
  executor: DbOrTx = db
): Promise<boolean> {
  const result = await executor
    .select({ scopes: oauthConsentGrants.scopes })
    .from(oauthConsentGrants)
    .where(
      and(
        eq(oauthConsentGrants.userId, userId),
        eq(oauthConsentGrants.clientId, clientId),
        isNull(oauthConsentGrants.revokedAt)
      )
    )
    .limit(1);

  if (result.length === 0) {
    return false;
  }

  // Check if all requested scopes are in the granted scopes
  const grantedScopes = result[0].scopes;
  return scopes.every((scope) => grantedScopes.includes(scope));
}

/**
 * Records user consent for a client.
 */
export async function recordConsent(
  userId: string,
  clientId: string,
  scopes: string[]
): Promise<void> {
  await db
    .insert(oauthConsentGrants)
    .values({
      id: generateUuidv7(),
      userId,
      clientId,
      scopes,
    })
    .onConflictDoUpdate({
      target: [oauthConsentGrants.userId, oauthConsentGrants.clientId],
      set: {
        scopes,
        updatedAt: new Date(),
        revokedAt: null, // Clear any previous revocation
      },
    });
}

/**
 * A consent grant as presented to the user in Settings.
 *
 * CIMD clients are never stored in `oauth_clients`, so a grant to one has no
 * name here: `clientHost` (the client_id URL's hostname) is its only identity
 * we can vouch for, matching what the consent screen leads with. We
 * deliberately don't re-fetch metadata documents to label a list — that would
 * be one outbound fetch per row, on a page render, for a self-asserted name.
 */
export interface UserConsentGrantSummary {
  clientId: string;
  /** Name from our own client registry; null for CIMD clients. */
  clientName: string | null;
  /** Hostname of a CIMD client's client_id URL; null for registered clients. */
  clientHost: string | null;
  scopes: string[];
  /** When consent was last recorded — re-consenting refreshes it. */
  grantedAt: Date;
  /**
   * Most recent use of an access token for this client. Null once the tokens
   * that recorded it have been reaped, so "no recent use", not "never used".
   */
  lastUsedAt: Date | null;
}

/**
 * Lists the user's active consent grants for the Settings UI.
 */
export async function listUserConsentGrants(userId: string): Promise<UserConsentGrantSummary[]> {
  const grants = await db
    .select({
      clientId: oauthConsentGrants.clientId,
      clientName: oauthClients.name,
      scopes: oauthConsentGrants.scopes,
      grantedAt: oauthConsentGrants.updatedAt,
    })
    .from(oauthConsentGrants)
    .leftJoin(oauthClients, eq(oauthClients.clientId, oauthConsentGrants.clientId))
    .where(and(eq(oauthConsentGrants.userId, userId), isNull(oauthConsentGrants.revokedAt)))
    .orderBy(desc(oauthConsentGrants.updatedAt));

  const lastUsed = await db
    .select({
      clientId: oauthAccessTokens.clientId,
      lastUsedAt: max(oauthAccessTokens.lastUsedAt),
    })
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.userId, userId))
    .groupBy(oauthAccessTokens.clientId);

  const lastUsedByClient = new Map(lastUsed.map((row) => [row.clientId, row.lastUsedAt]));

  return grants.map((grant) => {
    // The built-in app client has no oauth_clients row.
    const builtIn = grant.clientId === APP_CLIENT_ID ? getAppClient() : null;
    const clientName = builtIn?.name ?? grant.clientName;
    return {
      clientId: grant.clientId,
      clientName,
      clientHost: cimdClientHost(grant.clientId, { fromDatabase: clientName !== null }),
      scopes: grant.scopes,
      grantedAt: grant.grantedAt,
      lastUsedAt: lastUsedByClient.get(grant.clientId) ?? null,
    };
  });
}

/**
 * Revokes the user's consent for a client and kills everything outstanding it
 * could still trade for access.
 *
 * Every half matters: dropping only the consent grant would leave live access
 * and refresh tokens (and the refresh chain renewing itself indefinitely),
 * dropping only the tokens would let the client walk back through
 * /oauth/authorize silently since consent is what suppresses the prompt, and
 * leaving an unredeemed authorization code would buy it a fresh hour-long
 * access token plus a 30-day refresh chain minutes after the user said no.
 *
 * The consent grant is revoked **first**, so the two token-redemption paths
 * that re-check it (`rotateRefreshToken({ requireUserConsent })` and the
 * authorization-code exchange) fail closed for anything racing this sweep.
 *
 * Returns false if the user has no active grant for the client.
 */
export async function revokeUserConsentGrant(userId: string, clientId: string): Promise<boolean> {
  const now = new Date();

  const revokedGrants = await db
    .update(oauthConsentGrants)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(oauthConsentGrants.userId, userId),
        eq(oauthConsentGrants.clientId, clientId),
        isNull(oauthConsentGrants.revokedAt)
      )
    )
    .returning({ id: oauthConsentGrants.id });

  if (revokedGrants.length === 0) {
    return false;
  }

  await db
    .update(oauthAuthorizationCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(oauthAuthorizationCodes.userId, userId),
        eq(oauthAuthorizationCodes.clientId, clientId),
        isNull(oauthAuthorizationCodes.usedAt)
      )
    );

  await revokeUserClientTokens(userId, clientId, db, now);

  logger.info("User revoked OAuth consent grant", { component: "oauth", userId, clientId });

  return true;
}

/**
 * Revokes every live access and refresh token a user holds for one client.
 */
export async function revokeUserClientTokens(
  userId: string,
  clientId: string,
  executor: DbOrTx = db,
  now: Date = new Date()
): Promise<void> {
  await executor
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(oauthRefreshTokens.userId, userId),
        eq(oauthRefreshTokens.clientId, clientId),
        isNull(oauthRefreshTokens.revokedAt)
      )
    );

  await executor
    .update(oauthAccessTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(oauthAccessTokens.userId, userId),
        eq(oauthAccessTokens.clientId, clientId),
        isNull(oauthAccessTokens.revokedAt)
      )
    );
}
