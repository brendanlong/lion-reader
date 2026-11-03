/**
 * Ingest Addresses Router
 *
 * Handles CRUD operations for email ingest addresses.
 * Users can create unique email addresses to receive newsletter subscriptions.
 * Email format: {token}@{ingestDomain}
 */

import { z } from "zod";
import { eq, and, isNull, sql } from "drizzle-orm";

import {
  createTRPCRouter,
  confirmedProtectedProcedure as protectedProcedure,
  expensiveConfirmedProtectedProcedure as expensiveProtectedProcedure,
} from "../trpc";
import { errors } from "@/server/errors";
import { uuidSchema } from "../validation";
import { ingestAddresses } from "@/server/db/schema";
import { ingestConfig } from "@/server/config/env";
import { createIngestAddress } from "@/server/services/ingest-addresses";

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Label validation schema.
 */
const labelSchema = z.string().max(100, "Label must be less than 100 characters").trim().nullable();

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Ingest address output schema - what we return for an ingest address.
 */
const ingestAddressOutputSchema = z.object({
  id: z.string(),
  token: z.string(),
  email: z.string(),
  label: z.string().nullable(),
  createdAt: z.date(),
});

// ============================================================================
// Helper Functions
// ============================================================================

function requireIngestDomain(): string {
  const domain = ingestConfig.enabledDomain;
  if (!domain) throw errors.newslettersNotConfigured();
  return domain;
}

// ============================================================================
// Router
// ============================================================================

export const ingestAddressesRouter = createTRPCRouter({
  /**
   * List all ingest addresses for the current user.
   *
   * Returns all non-deleted ingest addresses with computed email field.
   * Addresses are ordered by creation time (newest first). `enabled` is false,
   * with no items, when newsletters aren't set up on this server.
   */
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/ingest-addresses",
        tags: ["Ingest Addresses"],
        summary: "List ingest addresses",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        enabled: z.boolean(),
        items: z.array(ingestAddressOutputSchema),
      })
    )
    .query(async ({ ctx }) => {
      const domain = ingestConfig.enabledDomain;
      if (!domain) return { enabled: false, items: [] };

      const userId = ctx.session.user.id;

      // Get all non-deleted ingest addresses for the user
      const addresses = await ctx.db
        .select()
        .from(ingestAddresses)
        .where(and(eq(ingestAddresses.userId, userId), isNull(ingestAddresses.deletedAt)))
        .orderBy(sql`${ingestAddresses.createdAt} DESC`);

      return {
        enabled: true,
        items: addresses.map((address) => ({
          id: address.id,
          token: address.token,
          email: `${address.token}@${domain}`,
          label: address.label,
          createdAt: address.createdAt,
        })),
      };
    }),

  /**
   * Create a new ingest address.
   *
   * Generates a secure random token and creates a new ingest address.
   * Enforces the plan's limit on addresses.
   *
   * @param label - Optional user-provided name for the address
   * @returns The created ingest address with computed email
   *
   * Note: This endpoint uses stricter rate limiting (10 burst, 1/sec)
   * to prevent abuse.
   */
  create: expensiveProtectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/ingest-addresses",
        tags: ["Ingest Addresses"],
        summary: "Create an ingest address",
      },
    })
    .input(
      z.object({
        label: labelSchema.optional(),
      })
    )
    .output(
      z.object({
        address: ingestAddressOutputSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const domain = requireIngestDomain();
      const userId = ctx.session.user.id;

      const address = await createIngestAddress(ctx.db, userId, input.label ?? null);

      return { address: { ...address, email: `${address.token}@${domain}` } };
    }),

  /**
   * Update an ingest address.
   *
   * Allows updating the label of an ingest address.
   * Only the owner can update their addresses.
   *
   * @param id - The ingest address ID
   * @param label - Optional new label (or null to remove)
   * @returns The updated ingest address
   */
  update: protectedProcedure
    .meta({
      openapi: {
        method: "PATCH",
        path: "/ingest-addresses/{id}",
        tags: ["Ingest Addresses"],
        summary: "Update an ingest address",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
        label: labelSchema.optional(),
      })
    )
    .output(
      z.object({
        address: ingestAddressOutputSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const domain = requireIngestDomain();
      const userId = ctx.session.user.id;

      // Verify the address exists and belongs to the user
      const existingAddress = await ctx.db
        .select()
        .from(ingestAddresses)
        .where(
          and(
            eq(ingestAddresses.id, input.id),
            eq(ingestAddresses.userId, userId),
            isNull(ingestAddresses.deletedAt)
          )
        )
        .limit(1);

      if (existingAddress.length === 0) {
        throw errors.ingestAddressNotFound();
      }

      const address = existingAddress[0];

      // Build the update object
      const updateData: { label?: string | null } = {};

      if (input.label !== undefined) {
        updateData.label = input.label;
      }

      // Update the address if there are changes
      if (Object.keys(updateData).length > 0) {
        await ctx.db
          .update(ingestAddresses)
          .set(updateData)
          .where(eq(ingestAddresses.id, input.id));
      }

      return {
        address: {
          id: address.id,
          token: address.token,
          email: `${address.token}@${domain}`,
          label: input.label !== undefined ? input.label : address.label,
          createdAt: address.createdAt,
        },
      };
    }),

  /**
   * Delete an ingest address (soft delete).
   *
   * Sets deletedAt timestamp instead of hard deleting.
   * Future emails to this address will be rejected.
   * Existing feeds and entries are unaffected.
   * Only the owner can delete their addresses.
   *
   * @param id - The ingest address ID
   * @returns Success status
   */
  delete: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/ingest-addresses/{id}",
        tags: ["Ingest Addresses"],
        summary: "Delete an ingest address",
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

      // Verify the address exists and belongs to the user
      const existingAddress = await ctx.db
        .select()
        .from(ingestAddresses)
        .where(
          and(
            eq(ingestAddresses.id, input.id),
            eq(ingestAddresses.userId, userId),
            isNull(ingestAddresses.deletedAt)
          )
        )
        .limit(1);

      if (existingAddress.length === 0) {
        throw errors.ingestAddressNotFound();
      }

      // Soft delete by setting deletedAt
      const now = new Date();
      await ctx.db
        .update(ingestAddresses)
        .set({ deletedAt: now })
        .where(eq(ingestAddresses.id, input.id));

      return { success: true };
    }),
});
