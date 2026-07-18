/**
 * Discord bot account-link storage.
 *
 * The Discord bot lets users link their Lion Reader account with an API token
 * (`/link`). That linkage lives here in Postgres — durable across deploys and
 * Redis data loss, unlike the old Redis-only `discord:token:*` storage
 * (#1370) — stored as a reference to the api_tokens row rather than the raw
 * token, so no secret is kept at rest and the link auto-invalidates when the
 * token is deleted. OAuth-based links live in `oauthAccounts` and are resolved
 * directly by the bot; this module only covers the API-token path.
 */

import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Database } from "@/server/db";
import { apiTokens, discordApiTokenLinks } from "@/server/db/schema";

/**
 * Link a Discord user to an API token (by token-row id). Upserts, so re-running
 * `/link` replaces any previous link for that Discord user.
 */
export async function linkDiscordApiToken(
  db: Database,
  discordId: string,
  tokenId: string
): Promise<void> {
  await db
    .insert(discordApiTokenLinks)
    .values({ discordId, tokenId })
    .onConflictDoUpdate({
      target: discordApiTokenLinks.discordId,
      set: { tokenId, createdAt: new Date() },
    });
}

/**
 * Resolve the Lion Reader user id linked to a Discord user via API token, or
 * `null` if there is no link or the linked token is revoked/expired. Does not
 * fall back to OAuth — the caller checks that separately. Because api_tokens is
 * `ON DELETE CASCADE` from users, a live token implies a live user.
 */
export async function resolveDiscordApiTokenUserId(
  db: Database,
  discordId: string
): Promise<string | null> {
  const result = await db
    .select({ userId: apiTokens.userId })
    .from(discordApiTokenLinks)
    .innerJoin(apiTokens, eq(apiTokens.id, discordApiTokenLinks.tokenId))
    .where(
      and(
        eq(discordApiTokenLinks.discordId, discordId),
        isNull(apiTokens.revokedAt),
        // Not expired (null means no expiry)
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date()))
      )
    )
    .limit(1);

  return result[0]?.userId ?? null;
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
