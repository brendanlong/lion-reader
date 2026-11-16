/**
 * Ingest addresses: the email addresses a user receives newsletters at
 * (`{token}@{ingestDomain}`).
 */

import { randomBytes } from "crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
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

/** The user's addresses that aren't deleted. */
function liveAddresses(userId: string) {
  return and(eq(ingestAddresses.userId, userId), isNull(ingestAddresses.deletedAt));
}

/** The user's ingest addresses that count toward the plan's limit. */
export async function countIngestAddresses(db: DbOrTx, userId: string): Promise<number> {
  const [{ addressCount }] = await db
    .select({ addressCount: sql<number>`count(*)::int` })
    .from(ingestAddresses)
    .where(liveAddresses(userId));
  return addressCount;
}

export interface IngestAddressInfo {
  id: string;
  token: string;
  label: string | null;
  createdAt: Date;
}

const ingestAddressInfoFields = {
  id: ingestAddresses.id,
  token: ingestAddresses.token,
  label: ingestAddresses.label,
  createdAt: ingestAddresses.createdAt,
};

/** One of the user's live addresses, by id. */
function ownedLiveAddress(userId: string, id: string) {
  return and(eq(ingestAddresses.id, id), liveAddresses(userId));
}

/** The user's live ingest addresses, newest first. */
export async function listIngestAddresses(
  db: DbOrTx,
  userId: string
): Promise<IngestAddressInfo[]> {
  return db
    .select(ingestAddressInfoFields)
    .from(ingestAddresses)
    .where(liveAddresses(userId))
    .orderBy(desc(ingestAddresses.createdAt));
}

/**
 * Updates one of the user's live addresses; an omitted `label` is left as is.
 *
 * @throws ingestAddressNotFound
 */
export async function updateIngestAddress(
  db: DbOrTx,
  userId: string,
  id: string,
  changes: { label?: string | null }
): Promise<IngestAddressInfo> {
  const [address] = await db
    .update(ingestAddresses)
    .set({ label: changes.label === undefined ? sql`${ingestAddresses.label}` : changes.label })
    .where(ownedLiveAddress(userId, id))
    .returning(ingestAddressInfoFields);
  if (!address) throw errors.ingestAddressNotFound();
  return address;
}

/**
 * Soft-deletes one of the user's live addresses: mail to it is rejected from
 * now on, while the subscriptions and entries it brought in stay.
 *
 * @throws ingestAddressNotFound
 */
export async function deleteIngestAddress(db: DbOrTx, userId: string, id: string): Promise<void> {
  const deleted = await db
    .update(ingestAddresses)
    .set({ deletedAt: new Date() })
    .where(ownedLiveAddress(userId, id))
    .returning({ id: ingestAddresses.id });
  if (deleted.length === 0) throw errors.ingestAddressNotFound();
}

/**
 * Creates an ingest address, up to the plan's limit. A per-user lock
 * serializes the count and insert, so concurrent creates can't pass the limit.
 */
export async function createIngestAddress(
  db: typeof dbType,
  userId: string,
  label: string | null
): Promise<IngestAddressInfo> {
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
