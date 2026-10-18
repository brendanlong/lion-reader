/**
 * Admin-issued signup invites. Redeeming one is part of signup (`auth/signup.ts`).
 */

import crypto from "crypto";
import { z } from "zod";
import { and, desc, eq, ilike, isNull, lt } from "drizzle-orm";
import type { Database } from "@/server/db";
import { invites, users } from "@/server/db/schema";
import { containsPattern } from "@/server/db/like";
import { appUrl } from "@/server/config/env";
import { generateUuidv7 } from "@/lib/uuidv7";
import { createCursorCodec, cursorUuid } from "@/server/services/cursor";

/** Invite validity duration in days */
const INVITE_VALIDITY_DAYS = 7;

/** Keyset cursor matching the invite list's ORDER BY id DESC. */
const inviteCursor = createCursorCodec(z.object({ id: cursorUuid }));

/** Generate a random invite token (URL-safe base64) */
function generateInviteToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

interface CreatedInvite {
  invite: { id: string; token: string; expiresAt: Date };
  inviteUrl: string;
}

/** Creates a one-time invite that expires in {@link INVITE_VALIDITY_DAYS} days. */
export async function createInvite(db: Database): Promise<CreatedInvite> {
  const id = generateUuidv7();
  const token = generateInviteToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(invites).values({
    id,
    token,
    expiresAt,
    createdAt: now,
  });

  return {
    invite: { id, token, expiresAt },
    inviteUrl: `${appUrl}/register?invite=${token}`,
  };
}

interface ListInvitesParams {
  limit: number;
  cursor?: string;
  /** Partial, case-insensitive match on the email of the user who used it. */
  search?: string;
}

interface InviteListItem {
  id: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
  status: "pending" | "used" | "expired";
  usedAt: Date | null;
  usedByEmail: string | null;
}

/** Lists invites newest first (UUIDv7 id DESC). */
export async function listInvites(
  db: Database,
  { limit, cursor, search }: ListInvitesParams
): Promise<{ items: InviteListItem[]; nextCursor?: string }> {
  const now = new Date();
  const conditions = [];

  if (cursor) {
    conditions.push(lt(invites.id, inviteCursor.decode(cursor).id));
  }

  if (search) {
    conditions.push(ilike(users.email, containsPattern(search)));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: invites.id,
      token: invites.token,
      expiresAt: invites.expiresAt,
      createdAt: invites.createdAt,
      usedAt: invites.usedAt,
      usedByEmail: users.email,
    })
    .from(invites)
    .leftJoin(users, eq(invites.usedByUserId, users.id))
    .where(whereClause)
    .orderBy(desc(invites.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? inviteCursor.encode({ id: items[items.length - 1].id }) : undefined;

  return {
    items: items.map((inv) => {
      let status: "pending" | "used" | "expired";
      if (inv.usedAt) {
        status = "used";
      } else if (inv.expiresAt < now) {
        status = "expired";
      } else {
        status = "pending";
      }

      return { ...inv, status };
    }),
    nextCursor,
  };
}

/** Deletes an invite, unless it has been used. */
export async function revokeInvite(db: Database, inviteId: string): Promise<void> {
  await db.delete(invites).where(and(eq(invites.id, inviteId), isNull(invites.usedAt)));
}
