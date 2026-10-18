/**
 * Discord bot account-link storage.
 *
 * The Discord bot lets users link their Lion Reader account with an API token
 * (`/link`). That linkage lives here in Postgres — durable across deploys and
 * Redis data loss, unlike the old Redis-only `discord:token:*` storage
 * (#1370) — stored as a reference to the api_tokens row rather than the raw
 * token, so no secret is kept at rest and the link auto-invalidates when the
 * token is deleted. OAuth-based links live in `oauthAccounts`.
 */

import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Database } from "@/server/db";
import { apiTokens, discordApiTokenLinks, oauthAccounts, users } from "@/server/db/schema";
import { isSignupConfirmed } from "@/server/auth/confirmation";

/**
 * Link a Discord user to an API token (by token-row id). Upserts, so re-running
 * `/link` replaces any previous link for that Discord user.
 */
export async function linkDiscordApiToken(
  db: Database,
  discordId: string,
  tokenId: string
): Promise<void> {
  await db.insert(discordApiTokenLinks).values({ discordId, tokenId }).onConflictDoUpdate({
    // Only swap the token; leave created_at as the first-link timestamp.
    target: discordApiTokenLinks.discordId,
    set: { tokenId },
  });
}

export interface DiscordUser {
  userId: string;
  method: "oauth" | "token";
  /**
   * Whether the user finished signup confirmation (`isSignupConfirmed`). The
   * bot must not save for an unconfirmed user, like every other companion
   * surface (SECURITY.md §8): a first Discord sign-in creates the account before
   * its owner accepts the Terms.
   */
  confirmed: boolean;
}

const userConsentColumns = {
  userId: users.id,
  tosAgreedAt: users.tosAgreedAt,
  privacyPolicyAgreedAt: users.privacyPolicyAgreedAt,
  notEuAgreedAt: users.notEuAgreedAt,
};

/**
 * Resolve the Lion Reader user linked to a Discord user: the Discord OAuth link
 * first, then the API-token link. Returns `null` if neither exists or the
 * linked token is revoked/expired.
 */
export async function resolveDiscordUser(
  db: Database,
  discordId: string
): Promise<DiscordUser | null> {
  const [oauth] = await db
    .select(userConsentColumns)
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(
      and(eq(oauthAccounts.provider, "discord"), eq(oauthAccounts.providerAccountId, discordId))
    )
    .limit(1);
  if (oauth) {
    return { userId: oauth.userId, method: "oauth", confirmed: isSignupConfirmed(oauth) };
  }

  const [token] = await db
    .select(userConsentColumns)
    .from(discordApiTokenLinks)
    .innerJoin(apiTokens, eq(apiTokens.id, discordApiTokenLinks.tokenId))
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(discordApiTokenLinks.discordId, discordId),
        isNull(apiTokens.revokedAt),
        // Not expired (null means no expiry)
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date()))
      )
    )
    .limit(1);
  if (token) {
    return { userId: token.userId, method: "token", confirmed: isSignupConfirmed(token) };
  }

  return null;
}

/**
 * Remove a Discord user's API-token link. Returns whether a link existed (so the
 * caller can tailor the `/unlink` reply). The OAuth link, if any, is untouched.
 */
export async function unlinkDiscordApiToken(db: Database, discordId: string): Promise<boolean> {
  const deleted = await db
    .delete(discordApiTokenLinks)
    .where(eq(discordApiTokenLinks.discordId, discordId))
    .returning({ discordId: discordApiTokenLinks.discordId });

  return deleted.length > 0;
}
