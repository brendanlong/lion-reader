/**
 * Taking an account back from whoever held it before its email was verified
 * (SECURITY.md §4): a verified provider sign-in claiming it
 * (`claimUnverifiedAccount`) or a password reset by the address's owner.
 */

import { and, eq, isNull } from "drizzle-orm";

import type { Transaction } from "@/server/db";
import {
  apiTokens,
  oauthAccounts,
  oauthAuthorizationCodes,
  oauthConsentGrants,
  oauthTokenGrants,
} from "@/server/db/schema";
import { deleteTokenGrants } from "@/server/oauth/service";

/**
 * Removes every credential an account has besides its password and sessions,
 * which the callers replace and revoke themselves: provider links, API tokens,
 * OAuth grants and unredeemed codes. The account's data is kept, including its
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
}
