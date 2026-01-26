/**
 * Admin Router
 *
 * Handles admin operations like managing invites.
 * All endpoints require ALLOWLIST_SECRET Bearer token.
 */

import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import crypto from "crypto";

import { createTRPCRouter, adminProcedure } from "../trpc";
import { invites, users } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";

/** Invite validity duration in days */
const INVITE_VALIDITY_DAYS = 7;

/** Generate a random invite token (URL-safe base64) */
function generateInviteToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Get the app URL for generating invite links */
function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export const adminRouter = createTRPCRouter({
  /**
   * Create a new invite.
   *
   * Generates a one-time use invite link that expires in 7 days.
   * Returns the full URL that can be shared with the user.
   */
  createInvite: adminProcedure
    .input(z.object({}).optional())
    .output(
      z.object({
        invite: z.object({
          id: z.string(),
          token: z.string(),
          expiresAt: z.date(),
        }),
        inviteUrl: z.string(),
      })
    )
    .mutation(async ({ ctx }) => {
      const id = generateUuidv7();
      const token = generateInviteToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + INVITE_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

      await ctx.db.insert(invites).values({
        id,
        token,
        expiresAt,
        createdAt: now,
      });

      const appUrl = getAppUrl();
      const inviteUrl = `${appUrl}/register?invite=${token}`;

      return {
        invite: {
          id,
          token,
          expiresAt,
        },
        inviteUrl,
      };
    }),

  /**
   * List all invites.
   *
   * Returns all invites with their status (pending, used, expired).
   */
  listInvites: adminProcedure
    .input(z.object({}).optional())
    .output(
      z.object({
        invites: z.array(
          z.object({
            id: z.string(),
            token: z.string(),
            expiresAt: z.date(),
            createdAt: z.date(),
            status: z.enum(["pending", "used", "expired"]),
            usedAt: z.date().nullable(),
            usedByEmail: z.string().nullable(),
          })
        ),
      })
    )
    .query(async ({ ctx }) => {
      const now = new Date();

      // Get all invites with user email via LEFT JOIN
      const allInvites = await ctx.db
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
        .orderBy(invites.createdAt);

      return {
        invites: allInvites.map((inv) => {
          let status: "pending" | "used" | "expired";
          if (inv.usedAt) {
            status = "used";
          } else if (inv.expiresAt < now) {
            status = "expired";
          } else {
            status = "pending";
          }

          return {
            id: inv.id,
            token: inv.token,
            expiresAt: inv.expiresAt,
            createdAt: inv.createdAt,
            status,
            usedAt: inv.usedAt,
            usedByEmail: inv.usedByEmail,
          };
        }),
      };
    }),

  /**
   * Revoke an unused invite.
   *
   * Deletes the invite so it can no longer be used.
   * Only pending (unused, non-expired) invites can be revoked.
   */
  revokeInvite: adminProcedure
    .input(
      z.object({
        inviteId: z.string().uuid(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { inviteId } = input;

      // Delete only if unused
      await ctx.db.delete(invites).where(and(eq(invites.id, inviteId), isNull(invites.usedAt)));

      return { success: true };
    }),
});
