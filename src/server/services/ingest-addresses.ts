/**
 * Ingest addresses: the email addresses a user receives newsletters at
 * (`{token}@{ingestDomain}`).
 */

import { randomBytes } from "crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { db as dbType, DbOrTx } from "@/server/db";
import { ingestAddresses } from "@/server/db/schema";
import { errors } from "@/server/errors";
import { generateUuidv7 } from "@/lib/uuidv7";
import { getUserPlanLimits } from "@/server/services/plans";

/**
 * Length of the random token in bytes (16 bytes = 128 bits).
 * Encoded as base64url, this produces a 22-character string.
 */
const TOKEN_BYTES = 16;

/**
 * A secure random token: base64url (URL-safe, no padding), lowercased for
 * case-insensitive matching with email addresses.
 */
function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url").toLowerCase();
}

/** The user's ingest addresses that count toward the plan's limit. */
export async function countIngestAddresses(db: DbOrTx, userId: string): Promise<number> {
  const [{ addressCount }] = await db
    .select({ addressCount: sql<number>`count(*)::int` })
    .from(ingestAddresses)
    .where(and(eq(ingestAddresses.userId, userId), isNull(ingestAddresses.deletedAt)));
  return addressCount;
}

interface CreatedIngestAddress {
  id: string;
  token: string;
  label: string | null;
  createdAt: Date;
}

/**
 * Creates an ingest address, up to the plan's limit. A per-user lock
 * serializes the count and insert, so concurrent creates can't pass the limit.
 */
export async function createIngestAddress(
  db: typeof dbType,
  userId: string,
  label: string | null
): Promise<CreatedIngestAddress> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ingest-addresses:${userId}`}))`);
    const { maxIngestAddresses } = await getUserPlanLimits(tx, userId);
    if (maxIngestAddresses !== null) {
      const count = await countIngestAddresses(tx, userId);
      if (count >= maxIngestAddresses) {
        throw errors.maxIngestAddressesReached(maxIngestAddresses);
      }
    }

    const address = { id: generateUuidv7(), token: generateToken(), label, createdAt: new Date() };
    await tx.insert(ingestAddresses).values({ ...address, userId });
    return address;
  });
}
