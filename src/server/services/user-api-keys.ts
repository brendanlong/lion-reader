/**
 * Users' own AI provider API keys (`user_api_keys`), stored encrypted.
 *
 * Keys are intentionally not loaded with the session user: read them here
 * only when the key values are needed (narration, summarization).
 */

import * as Sentry from "@sentry/nextjs";
import { and, eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/server/db";
import { userApiKeys } from "@/server/db/schema";
import { isUserKeyProvider, type UserKeyProvider } from "@/lib/ai/providers";
import {
  assertEncryptionConfigured,
  decryptApiKey,
  encryptApiKey,
  isEncryptionConfigured,
} from "@/lib/encryption";
import { errors } from "@/server/errors";
import type { AiProviderKeys } from "@/server/services/ai-providers";
import { UNREADABLE_API_KEY } from "@/server/services/unreadable-api-key";

/** The providers `userId` has their own API key for (not the keys). */
export async function getApiKeyProviders(userId: string): Promise<UserKeyProvider[]> {
  const rows = await db
    .select({ provider: userApiKeys.provider })
    .from(userApiKeys)
    .where(eq(userApiKeys.userId, userId))
    .orderBy(userApiKeys.provider);
  return rows.map((row) => row.provider).filter(isUserKeyProvider);
}

/**
 * Fetches and decrypts a user's API keys.
 *
 * A missing or malformed `API_KEY_ENCRYPTION_KEY` throws. A key that doesn't
 * decrypt under it is reported and comes back as `UNREADABLE_API_KEY`, so
 * the user's other keys still work and that provider doesn't quietly move
 * onto the server's key. The row stays: a wrong (but well-formed) encryption
 * key fails every row, and fixing it should bring them all back.
 */
export async function getUserApiKeys(userId: string): Promise<AiProviderKeys> {
  const rows = await db
    .select({ provider: userApiKeys.provider, encryptedKey: userApiKeys.encryptedKey })
    .from(userApiKeys)
    .where(eq(userApiKeys.userId, userId));
  if (rows.length > 0) {
    assertEncryptionConfigured();
  }
  const keys: AiProviderKeys = {};
  for (const { provider, encryptedKey } of rows) {
    if (!isUserKeyProvider(provider)) continue;
    try {
      keys[provider] = decryptApiKey(encryptedKey);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { source: "api-key-decrypt", provider },
        extra: { userId },
      });
      keys[provider] = UNREADABLE_API_KEY;
    }
  }
  return keys;
}

/**
 * The providers whose saved key {@link getUserApiKeys} would find unreadable,
 * for Settings to ask for again. Never throws and reports nothing — that's for
 * actual use — and finds none when encryption isn't configured, where the
 * settings page hides keys altogether.
 */
export async function getUnreadableApiKeyProviders(userId: string): Promise<UserKeyProvider[]> {
  try {
    assertEncryptionConfigured();
  } catch {
    return [];
  }
  const rows = await db
    .select({ provider: userApiKeys.provider, encryptedKey: userApiKeys.encryptedKey })
    .from(userApiKeys)
    .where(eq(userApiKeys.userId, userId))
    .orderBy(userApiKeys.provider);
  return rows
    .filter(({ encryptedKey }) => {
      try {
        decryptApiKey(encryptedKey);
        return false;
      } catch {
        return true;
      }
    })
    .map((row) => row.provider)
    .filter(isUserKeyProvider);
}

/**
 * Sets (a non-empty key) or removes (`""`) each given provider's key. Throws a
 * validation error, before writing anything, if a key is to be stored while
 * encryption isn't configured.
 */
export async function setUserApiKeys(
  tx: DbOrTx,
  userId: string,
  apiKeys: ReadonlyArray<readonly [UserKeyProvider, string]>
): Promise<void> {
  if (apiKeys.some(([, key]) => key !== "") && !isEncryptionConfigured()) {
    throw errors.validation(
      "API key encryption is not configured on this server. Contact your administrator."
    );
  }
  for (const [provider, key] of apiKeys) {
    if (key) {
      const encryptedKey = encryptApiKey(key);
      await tx
        .insert(userApiKeys)
        .values({ userId, provider, encryptedKey })
        .onConflictDoUpdate({
          target: [userApiKeys.userId, userApiKeys.provider],
          set: { encryptedKey, updatedAt: new Date() },
        });
    } else {
      await tx
        .delete(userApiKeys)
        .where(and(eq(userApiKeys.userId, userId), eq(userApiKeys.provider, provider)));
    }
  }
}
