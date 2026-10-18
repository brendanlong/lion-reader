/**
 * OAuth Account Links Service
 *
 * Linking/unlinking a social provider (Google/Apple/Discord) to an *existing*
 * signed-in account. The login/signup side of OAuth — where the provider
 * identity decides which account you get — lives in
 * `src/server/auth/oauth/callback.ts` instead.
 *
 * Linking and unlinking add or remove a way to sign in, so both revoke the user's
 * other sessions (SECURITY.md §4) via `revokeOtherUserSessionsOrReport`, which owns
 * what happens when that revoke fails. The revoke lives here rather than in the
 * callers so a fourth provider can't forget it, and it fires only when a credential
 * really changed — see each function for what doesn't count.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/server/db";
import { oauthAccounts, users } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { revokeOtherUserSessionsOrReport } from "@/server/auth/session";
import { errors } from "@/server/errors";
import { PROVIDER_LABELS, type OAuthProviderName } from "@/server/auth/oauth/config";
import { oauthTokenColumns, type OAuthTokens } from "@/server/auth/oauth/token-exchange";

export interface AttachOAuthAccountParams extends OAuthTokens {
  /** The user the provider account is being attached to. */
  userId: string;
  provider: OAuthProviderName;
  /** The provider's stable id for the account (`sub` / Discord user id). */
  providerAccountId: string;
}

/**
 * Attach a provider account to a user, one link per provider. Every path that
 * adds a link to an existing user goes through here: a link from Settings
 * (`linkOAuthAccount`) and a sign-in that matched the user by email
 * (`processOAuthCallback`). It revokes nothing; that's the caller's decision.
 *
 * Re-attaching the *same* provider account is an update rather than an error, so
 * Google's incremental authorization (granting the Docs scope later) refreshes
 * the stored tokens and scopes in place. This holds for **every** provider, not
 * just Google: Apple and Discord used to reject any re-link, only because they
 * checked for an existing row before the callback gave them a
 * `providerAccountId` to compare against (#1467). Attaching a *different* account
 * for a provider the user already linked is refused.
 *
 * @returns `"updated"` when an existing link was refreshed, `"linked"` for a new one
 * @throws `oauthAlreadyLinked` when a different account of this provider is linked
 * @throws `oauthCallbackFailed` when this provider account belongs to another user
 */
export async function attachOAuthAccount(
  db: Database,
  params: AttachOAuthAccountParams
): Promise<"linked" | "updated"> {
  const { userId, provider, providerAccountId } = params;
  const label = PROVIDER_LABELS[provider];
  const tokenColumns = oauthTokenColumns(params);

  return db.transaction(async (tx) => {
    // Nothing enforces one link per (user_id, provider), so concurrent attaches for
    // this user (two first sign-ins with different accounts, a link clicked twice)
    // serialize on the user row: each then sees the link the other committed.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("no key update");

    // Ordered so a user who already has two rows for one provider resolves to
    // their oldest link deterministically, rather than to whichever row the
    // planner returns.
    const existingLink = await tx
      .select({ id: oauthAccounts.id, providerAccountId: oauthAccounts.providerAccountId })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)))
      .orderBy(oauthAccounts.createdAt)
      .limit(1);

    if (existingLink.length > 0) {
      if (existingLink[0].providerAccountId !== providerAccountId) {
        throw errors.oauthAlreadyLinked(label);
      }

      await tx
        .update(oauthAccounts)
        .set(tokenColumns)
        .where(eq(oauthAccounts.id, existingLink[0].id));

      return "updated";
    }

    // Insert, letting the (provider, provider_account_id) unique constraint decide
    // whether another user holds this provider account (the user lock doesn't
    // cover them). The conflict must *not* update that user's row, or one user
    // could take over another's link.
    const inserted = await tx
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
  });
}

export interface LinkOAuthAccountParams extends AttachOAuthAccountParams {
  /** The caller's session, kept alive when the credential change revokes the rest. */
  currentSessionId: string;
}

/**
 * Link a provider account to a signed-in user from Settings (`attachOAuthAccount`
 * says what's refused).
 *
 * Identity comes from the caller's **session**, not from the provider's email,
 * so — unlike `processOAuthCallback`, which picks the account by email — there
 * is deliberately no `emailVerified` check here (SECURITY.md §4). Don't add one,
 * and don't reuse this from a path where the session doesn't establish who the
 * user is.
 *
 * Only a new link revokes other sessions. Re-linking the account the user already
 * has grants no new way in, so it leaves them alone.
 */
export async function linkOAuthAccount(
  db: Database,
  params: LinkOAuthAccountParams
): Promise<"linked" | "updated"> {
  const result = await attachOAuthAccount(db, params);
  if (result === "linked") {
    await revokeOtherUserSessionsOrReport(
      params.userId,
      params.currentSessionId,
      `${PROVIDER_LABELS[params.provider]} linked`
    );
  }
  return result;
}

export interface ReauthorizeOAuthAccountParams extends OAuthTokens {
  /** The user who started the re-authorization. */
  userId: string;
  provider: OAuthProviderName;
  providerAccountId: string;
}

/**
 * Store the tokens from a re-authorization of a link the user already has (Google's
 * incremental authorization for Docs). Changes no credential, so revokes nothing.
 *
 * Matches the row by the flow's user as well as the provider account, so the
 * provider account the browser returned with can only update the flow user's own
 * link, never another user's.
 *
 * @returns whether that link existed (and was updated)
 */
export async function reauthorizeOAuthAccount(
  db: Database,
  params: ReauthorizeOAuthAccountParams
): Promise<boolean> {
  const updated = await db
    .update(oauthAccounts)
    .set(oauthTokenColumns(params))
    .where(
      and(
        eq(oauthAccounts.userId, params.userId),
        eq(oauthAccounts.provider, params.provider),
        eq(oauthAccounts.providerAccountId, params.providerAccountId)
      )
    )
    .returning({ id: oauthAccounts.id });
  return updated.length > 0;
}

export interface UnlinkOAuthAccountParams {
  userId: string;
  provider: OAuthProviderName;
  /** The caller's session, kept alive when the credential change revokes the rest. */
  currentSessionId: string;
}

/**
 * Unlink a provider from a user. Idempotent: unlinking a provider that isn't
 * linked succeeds instead of 404-ing.
 *
 * Only an unlink that removed a link revokes other sessions; a no-op one changes
 * no credential.
 *
 * @throws `cannotUnlinkOnlyAuth` when this is the user's last way to sign in
 */
export async function unlinkOAuthAccount(
  db: Database,
  { userId, provider, currentSessionId }: UnlinkOAuthAccountParams
): Promise<void> {
  const unlinked = await db.transaction(async (tx) => {
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
      return false;
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
    return true;
  });

  if (unlinked) {
    await revokeOtherUserSessionsOrReport(
      userId,
      currentSessionId,
      `${PROVIDER_LABELS[provider]} unlinked`
    );
  }
}
