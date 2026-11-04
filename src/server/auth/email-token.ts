/**
 * Single-use tokens for the links we email (verify an address, reset a password).
 *
 * A user may hold several live tokens of a purpose (each resend mints one, so
 * an older email still works); using any of them deletes them all.
 */

import { and, eq, gt } from "drizzle-orm";

import type { DbOrTx } from "@/server/db";
import { emailTokens, type EmailTokenPurpose } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { generateToken, hashToken } from "@/server/oauth/utils";

export const HOUR_MS = 60 * 60 * 1000;

export const EMAIL_TOKEN_LIFETIME_MS: Record<EmailTokenPurpose, number> = {
  verify_email: 24 * HOUR_MS,
  reset_password: HOUR_MS,
};

/** @returns the raw token, for the emailed link */
export async function createEmailToken(
  db: DbOrTx,
  userId: string,
  purpose: EmailTokenPurpose
): Promise<string> {
  const token = generateToken();
  await db.insert(emailTokens).values({
    id: generateUuidv7(),
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + EMAIL_TOKEN_LIFETIME_MS[purpose]),
  });
  return token;
}

/**
 * Uses a token: if it's live (and belongs to `userId`, when given), deletes
 * every token of its purpose the user holds.
 *
 * @returns the token's user, or null if it's unknown, expired or someone else's
 */
export async function consumeEmailToken(
  db: DbOrTx,
  token: string,
  purpose: EmailTokenPurpose,
  userId?: string
): Promise<string | null> {
  const tokenHash = hashToken(token);
  const [match] = await db
    .select({ userId: emailTokens.userId })
    .from(emailTokens)
    .where(
      and(
        eq(emailTokens.tokenHash, tokenHash),
        eq(emailTokens.purpose, purpose),
        gt(emailTokens.expiresAt, new Date()),
        userId ? eq(emailTokens.userId, userId) : undefined
      )
    );
  if (!match) {
    return null;
  }

  // Deleting the presented token is what makes it single-use: of two
  // concurrent uses, only one deletes it.
  const deleted = await db
    .delete(emailTokens)
    .where(and(eq(emailTokens.userId, match.userId), eq(emailTokens.purpose, purpose)))
    .returning({ tokenHash: emailTokens.tokenHash });
  return deleted.some((row) => row.tokenHash === tokenHash) ? match.userId : null;
}

/**
 * Deletes a user's live tokens of `purpose`: a password change or account claim
 * must not leave an older reset link able to undo it.
 */
export async function deleteEmailTokens(
  db: DbOrTx,
  userId: string,
  purpose: EmailTokenPurpose
): Promise<void> {
  await db
    .delete(emailTokens)
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose)));
}
