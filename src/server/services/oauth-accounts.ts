/**
 * OAuth Account Links Service
 *
 * Linking/unlinking a social provider (Google/Apple/Discord) to an *existing*
 * signed-in account. The login/signup side of OAuth — where the provider
 * identity decides which account you get — lives in
 * `src/server/auth/oauth/callback.ts` instead.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/server/db";
import { oauthAccounts, users } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { errors } from "@/server/trpc/errors";

/** Providers a user can link to an existing account. */
export type OAuthProvider = "google" | "apple" | "discord";

/** Human-readable provider name, for error messages. */
const PROVIDER_LABELS: Record<OAuthProvider, string> = {
  google: "Google",
  apple: "Apple",
  discord: "Discord",
};

export interface LinkOAuthAccountParams {
  /** The signed-in user the provider account is being attached to. */
  userId: string;
  provider: OAuthProvider;
  /** The provider's stable id for the account (`sub` / Discord user id). */
  providerAccountId: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  /** Granted scopes, where the provider reports them (Google). */
  scopes?: string[];
}

/**
 * Link a provider account to a signed-in user.
 *
 * Re-linking the *same* provider account is an update rather than an error, so
 * Google's incremental authorization (granting the Docs scope later) refreshes
 * the stored tokens and scopes in place. Linking a *different* account for a
 * provider the user already linked is refused — one link per provider.
 *
 * @returns `"updated"` when an existing link was refreshed, `"linked"` for a new one
 * @throws `oauthAlreadyLinked` when a different account of this provider is linked
 * @throws `oauthCallbackFailed` when this provider account belongs to another user
 */
export async function linkOAuthAccount(
  db: Database,
  params: LinkOAuthAccountParams
): Promise<"linked" | "updated"> {
  const { userId, provider, providerAccountId, accessToken, refreshToken, expiresAt, scopes } =
    params;
  const label = PROVIDER_LABELS[provider];

  const tokenColumns = {
    accessToken,
    refreshToken: refreshToken ?? null,
    expiresAt: expiresAt ?? null,
    // Leave stored scopes alone for providers that don't report them, rather
    // than clobbering them with NULL.
    ...(scopes !== undefined ? { scopes } : {}),
  };

  const existingLink = await db
    .select({ id: oauthAccounts.id, providerAccountId: oauthAccounts.providerAccountId })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)))
    .limit(1);

  if (existingLink.length > 0) {
    if (existingLink[0].providerAccountId !== providerAccountId) {
      throw errors.oauthAlreadyLinked(label);
    }

    await db
      .update(oauthAccounts)
      .set(tokenColumns)
      .where(eq(oauthAccounts.id, existingLink[0].id));

    return "updated";
  }

  // Insert, letting the (provider, provider_account_id) unique constraint decide
  // whether this provider account is already spoken for. Checking with a SELECT
  // first would leave a window where two concurrent links both see it free; the
  // conflict must *not* update, or one user could take over another's link.
  const inserted = await db
    .insert(oauthAccounts)
    .values({
      id: generateUuidv7(),
      userId,
      provider,
      providerAccountId,
      ...tokenColumns,
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: [oauthAccounts.provider, oauthAccounts.providerAccountId] })
    .returning({ id: oauthAccounts.id });

  if (inserted.length === 0) {
    throw errors.oauthCallbackFailed(`This ${label} account is already linked to another user`);
  }

  return "linked";
}

/**
 * Unlink a provider from a user. Idempotent: unlinking a provider that isn't
 * linked succeeds instead of 404-ing.
 *
 * @throws `cannotUnlinkOnlyAuth` when this is the user's last way to sign in
 */
export async function unlinkOAuthAccount(
  db: Database,
  userId: string,
  provider: OAuthProvider
): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize concurrent unlinks for this user by taking a row lock on the
    // user. Without it, two requests unlinking *different* providers (e.g.
    // Google in one tab, Apple in another) target different oauth_accounts
    // rows, so neither blocks the other. A single atomic DELETE with an
    // embedded count check does not close this race either: under READ
    // COMMITTED the count subquery reads a snapshot and takes no lock on the
    // other provider's row, so both requests observe two linked accounts, both
    // pass the check, and both delete — leaving the user with zero auth
    // methods (#825).
    await tx.execute(sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} FOR UPDATE`);

    const account = await tx
      .select({ id: oauthAccounts.id })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)))
      .limit(1);

    if (account.length === 0) {
      return;
    }

    // Safety check: refuse to remove the user's only remaining auth method. The
    // FOR UPDATE lock above guarantees this count and the delete below can't
    // interleave with another unlink for this user.
    const user = await tx
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const hasPassword = !!user[0]?.passwordHash;
    const linkedAccountsCount = await tx.$count(oauthAccounts, eq(oauthAccounts.userId, userId));

    if (!hasPassword && linkedAccountsCount <= 1) {
      throw errors.cannotUnlinkOnlyAuth();
    }

    await tx.delete(oauthAccounts).where(eq(oauthAccounts.id, account[0].id));
  });
}
