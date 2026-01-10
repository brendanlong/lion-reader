/**
 * Blocked Senders Router
 *
 * Handles CRUD operations for blocked email senders.
 * Users can view and unblock senders that were blocked when unsubscribing from email feeds.
 */

import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { blockedSenders } from "@/server/db/schema";

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * UUID validation schema for blocked sender IDs.
 */
const uuidSchema = z.string().uuid("Invalid blocked sender ID");

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Blocked sender output schema - what we return for a blocked sender.
 */
const blockedSenderOutputSchema = z.object({
  id: z.string(),
  senderEmail: z.string(),
  blockedAt: z.date(),
  unsubscribeSentAt: z.date().nullable(),
});

// ============================================================================
// Router
// ============================================================================

export const blockedSendersRouter = createTRPCRouter({
  /**
   * List all blocked senders for the current user.
   *
   * Returns all blocked senders with their email and block timestamp.
   * Senders are ordered by block time (newest first).
   */
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/blocked-senders",
        tags: ["Blocked Senders"],
        summary: "List blocked senders",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        items: z.array(blockedSenderOutputSchema),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      // Get all blocked senders for the user
      const senders = await ctx.db
        .select()
        .from(blockedSenders)
        .where(eq(blockedSenders.userId, userId))
        .orderBy(sql`${blockedSenders.blockedAt} DESC`);

      return {
        items: senders.map((sender) => ({
          id: sender.id,
          senderEmail: sender.senderEmail,
          blockedAt: sender.blockedAt,
          unsubscribeSentAt: sender.unsubscribeSentAt,
        })),
      };
    }),

  /**
   * Unblock a sender.
   *
   * Removes the sender from the blocked list, allowing future emails
   * from that sender to be processed again.
   * Only the owner can unblock their blocked senders.
   *
   * @param id - The blocked sender ID
   * @returns Success status
   */
  unblock: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/blocked-senders/{id}",
        tags: ["Blocked Senders"],
        summary: "Unblock a sender",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Delete directly - RETURNING verifies it existed and belonged to user
      const deleted = await ctx.db
        .delete(blockedSenders)
        .where(and(eq(blockedSenders.id, input.id), eq(blockedSenders.userId, userId)))
        .returning({ id: blockedSenders.id });

      if (deleted.length === 0) {
        throw errors.blockedSenderNotFound();
      }

      return { success: true };
    }),
});
