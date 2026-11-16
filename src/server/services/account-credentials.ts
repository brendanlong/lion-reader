/**
 * Credential changes that take other credentials with them (SECURITY.md §4):
 * replacing the password, and taking an account back from whoever held it
 * before its email was verified (a verified provider sign-in claiming it,
 * `claimUnverifiedAccount`, or a password reset by the address's owner).
 */

import { and, eq, isNull } from "drizzle-orm";

import type { Transaction } from "@/server/db";
import {
  apiTokens,
  oauthAccounts,
  oauthAuthorizationCodes,
  oauthConsentGrants,
  oauthTokenGrants,
  users,
} from "@/server/db/schema";
import { deleteTokenGrants } from "@/server/oauth/service";
import { revokeUserClientTokens } from "@/server/oauth/grants";
import { deleteEmailTokens } from "@/server/auth/email-token";
import { WALLABAG_CLIENT_ID } from "@/server/wallabag/client";

/**
 * Sets a user's password hash (setting, changing or resetting it), with what
 * must go with the old password in the same transaction: the Wallabag token
 * grants, which the password grant minted from it, and any reset link that
 * would undo the change. Sessions are the caller's: each path keeps a
 * different one.
 *
 * @param options.onlyIfUnset - Leave an account that already has a password
 *   unchanged (adding a password to a provider-only account)
 * @returns whether the password was set
 */
export async function replaceUserPassword(
  tx: Transaction,
  userId: string,
  passwordHash: string,
  options: { onlyIfUnset?: boolean } = {}
): Promise<boolean> {
  const updated = await tx
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(and(eq(users.id, userId), options.onlyIfUnset ? isNull(users.passwordHash) : undefined))
    .returning({ id: users.id });
  if (updated.length === 0) return false;

  await revokeUserClientTokens(userId, WALLABAG_CLIENT_ID, tx);
  await deleteEmailTokens(tx, userId, "reset_password");
  return true;
}

/**
 * Removes every credential an account has besides its password and sessions,
 * which the callers replace and revoke themselves: provider links, API tokens,
 * OAuth grants, unredeemed codes and password-reset links. The account's data is kept, including its
 * AI provider keys and newsletter addresses: an unverified account can't create
 * those, so they only exist on accounts from before verification, whose owners
 * we invited.
 */
export async function removeUnverifiedHolderCredentials(
  tx: Transaction,
  userId: string,
  now: Date
): Promise<void> {
  await tx.delete(oauthAccounts).where(eq(oauthAccounts.userId, userId));
  await tx
    .update(apiTokens)
    .set({ revokedAt: now })
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
  // A code redeems against any consent the user later gives its client.
  await tx.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, userId));
  await tx.delete(oauthConsentGrants).where(eq(oauthConsentGrants.userId, userId));
  await deleteTokenGrants(eq(oauthTokenGrants.userId, userId), tx);
  await deleteEmailTokens(tx, userId, "reset_password");
}
