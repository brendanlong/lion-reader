/**
 * Account emails: verifying an address, and resetting a password by email.
 *
 * An email-verification link only works for the account that's signed in.
 * Otherwise someone could register another person's address and wait for them
 * to click the link out of curiosity, leaving a verified account with the
 * registrant's password on it. A password reset needs no session, since it
 * replaces the password, and claims an unverified account the way a provider
 * sign-in does (`removeUnverifiedHolderCredentials`).
 */

import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "@/server/db";
import { sessions, users, type EmailTokenPurpose } from "@/server/db/schema";
import { readAppUrl } from "@/server/config/env";
import { errors } from "@/server/errors";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/server/rate-limit";
import {
  createEmailToken,
  consumeEmailToken,
  EMAIL_TOKEN_LIFETIME_MS,
  HOUR_MS,
} from "@/server/auth/email-token";
import { hashPassword } from "@/server/auth/password";
import { sendEmail } from "@/server/email/send";
import { revokeUserClientTokens } from "@/server/oauth/grants";
import { WALLABAG_CLIENT_ID } from "@/server/wallabag/client";
import { removeUnverifiedHolderCredentials } from "@/server/services/account-credentials";

function linkLifetime(purpose: EmailTokenPurpose): string {
  const hours = Math.round(EMAIL_TOKEN_LIFETIME_MS[purpose] / HOUR_MS);
  return hours === 1 ? "an hour" : `${hours} hours`;
}

async function consumeEmailAllowance(email: string): Promise<void> {
  const result = await checkRateLimit(`recipient:${email.toLowerCase()}`, "accountEmail", {
    fallback: "memory",
  });
  if (!result.allowed) {
    throw errors.accountEmailRateLimited(result.retryAfterSeconds ?? 60);
  }
}

/** Emails `user` a link that verifies their address. */
export async function sendVerificationEmail(
  db: Database,
  user: { id: string; email: string }
): Promise<void> {
  await consumeEmailAllowance(user.email);
  const token = await createEmailToken(db, user.id, "verify_email");
  await sendEmail({
    to: user.email,
    subject: "Verify your Lion Reader email address",
    text: [
      "Open this link while signed in to Lion Reader to verify your email address:",
      "",
      `${readAppUrl()}/verify-email?token=${token}`,
      "",
      `The link expires in ${linkLifetime("verify_email")}. If you didn't create a Lion Reader account, ignore this email.`,
    ].join("\n"),
  });
}

/** {@link sendVerificationEmail} for a request that must not wait on it or fail with it. */
export function sendVerificationEmailInBackground(
  db: Database,
  user: { id: string; email: string }
): void {
  sendVerificationEmail(db, user).catch((err: unknown) => {
    logger.error("Failed to send verification email", {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Verifies `userId`'s email with a token from {@link sendVerificationEmail}.
 *
 * @throws validation error if the token is unknown, expired or another account's
 */
export async function verifyEmail(db: Database, userId: string, token: string): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await consumeEmailToken(tx, token, "verify_email", userId))) {
      throw errors.validation(
        "This verification link is invalid or has expired, or it's for a different account."
      );
    }
    const now = new Date();
    await tx
      .update(users)
      .set({ emailVerifiedAt: now, updatedAt: now })
      .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
  });
}

/**
 * Emails a password-reset link to `email` if it has an account. Says nothing
 * about whether it does: the email goes out after this returns.
 */
export async function requestPasswordReset(db: Database, email: string): Promise<void> {
  await consumeEmailAllowance(email);
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email));
  if (!user) {
    return;
  }

  void (async () => {
    const token = await createEmailToken(db, user.id, "reset_password");
    await sendEmail({
      to: user.email,
      subject: "Reset your Lion Reader password",
      text: [
        "Open this link to choose a new Lion Reader password:",
        "",
        `${readAppUrl()}/reset-password?token=${token}`,
        "",
        `The link expires in ${linkLifetime("reset_password")}. If you didn't ask to reset your password, ignore this email.`,
      ].join("\n"),
    });
  })().catch((err: unknown) => {
    logger.error("Failed to send password reset email", {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Sets a new password with a token from {@link requestPasswordReset}. Following
 * the link proves the address, so this verifies the email too. Every session is
 * revoked, along with the Wallabag grants minted from the old password, or —
 * if the email wasn't verified until now — every other credential and the
 * registrant's signup agreements.
 *
 * @returns the account's user id
 * @throws validation error if the token is unknown or expired
 */
export async function resetPassword(
  db: Database,
  token: string,
  newPassword: string
): Promise<string> {
  const passwordHash = await hashPassword(newPassword);

  return db.transaction(async (tx) => {
    const userId = await consumeEmailToken(tx, token, "reset_password");
    if (!userId) {
      throw errors.validation("This password reset link is invalid or has expired.");
    }
    const now = new Date();

    // Sessions before the user row, the order `updateLastActiveAt` takes them in.
    await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    // Decided on the locked row, so a provider sign-in that verified the
    // account meanwhile keeps its link. An unverified account's agreements were
    // the registrant's, not the owner's.
    const claimed = await tx
      .update(users)
      .set({
        emailVerifiedAt: now,
        tosAgreedAt: null,
        privacyPolicyAgreedAt: null,
        notEuAgreedAt: null,
      })
      .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)))
      .returning({ id: users.id });
    await tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, userId));

    if (claimed.length > 0) {
      await removeUnverifiedHolderCredentials(tx, userId, now);
    } else {
      await revokeUserClientTokens(userId, WALLABAG_CLIENT_ID, tx);
    }
    return userId;
  });
}
