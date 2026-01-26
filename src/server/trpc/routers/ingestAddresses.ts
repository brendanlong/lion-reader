/**
 * Ingest Addresses Router
 *
 * Handles CRUD operations for email ingest addresses.
 * Users can create unique email addresses to receive newsletter subscriptions.
 * Email format: {token}@{ingestDomain}
 */

import { z } from "zod";
import { eq, and, isNull, sql } from "drizzle-orm";
import { randomBytes } from "crypto";

import { createTRPCRouter, protectedProcedure, expensiveProtectedProcedure } from "../trpc";
import { errors } from "../errors";
import { ingestAddresses } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { ingestConfig } from "@/server/config/env";

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of ingest addresses a user can create.
 */
const MAX_ADDRESSES_PER_USER = 5;

/**
 * Length of the random token in bytes (16 bytes = 128 bits).
 * Encoded as base64url, this produces a 22-character string.
 */
const TOKEN_BYTES = 16;

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * UUID validation schema for ingest address IDs.
 */
const uuidSchema = z.string().uuid("Invalid ingest address ID");

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

/**
 * Generates a secure random token for email addresses.
 * Uses base64url encoding (URL-safe, no padding), lowercased for
 * case-insensitive matching with email addresses.
 *
 * @returns A random token string (lowercase)
 */
function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url").toLowerCase();
}

/**
 * Computes the full email address from a token.
 *
 * @param token - The ingest address token
 * @returns The full email address
 */
function computeEmail(token: string): string {
  return `${token}@${ingestConfig.emailDomain}`;
}

// ============================================================================
// Router
// ============================================================================

export const ingestAddressesRouter = createTRPCRouter({
  /**
   * List all ingest addresses for the current user.
   *
   * Returns all non-deleted ingest addresses with computed email field.
   * Addresses are ordered by creation time (newest first).
   */
  list: protectedProcedure
    .input(z.object({}).optional())
    .output(
      z.object({
        items: z.array(ingestAddressOutputSchema),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      // Get all non-deleted ingest addresses for the user
      const addresses = await ctx.db
        .select()
        .from(ingestAddresses)
        .where(and(eq(ingestAddresses.userId, userId), isNull(ingestAddresses.deletedAt)))
        .orderBy(sql`${ingestAddresses.createdAt} DESC`);

      return {
        items: addresses.map((address) => ({
          id: address.id,
          token: address.token,
          email: computeEmail(address.token),
          label: address.label,
          createdAt: address.createdAt,
        })),
      };
    }),

  /**
   * Create a new ingest address.
   *
   * Generates a secure random token and creates a new ingest address.
   * Enforces a maximum of 5 addresses per user.
   *
   * @param label - Optional user-provided name for the address
   * @returns The created ingest address with computed email
   *
   * Note: This endpoint uses stricter rate limiting (10 burst, 1/sec)
   * to prevent abuse.
   */
  create: expensiveProtectedProcedure
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
      const userId = ctx.session.user.id;

      // Check current address count
      const countResult = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(ingestAddresses)
        .where(and(eq(ingestAddresses.userId, userId), isNull(ingestAddresses.deletedAt)));

      const currentCount = countResult[0]?.count ?? 0;

      if (currentCount >= MAX_ADDRESSES_PER_USER) {
        throw errors.maxIngestAddressesReached(MAX_ADDRESSES_PER_USER);
      }

      // Generate a unique token
      const token = generateToken();
      const addressId = generateUuidv7();
      const now = new Date();

      // Create the ingest address
      await ctx.db.insert(ingestAddresses).values({
        id: addressId,
        userId,
        token,
        label: input.label ?? null,
        createdAt: now,
      });

      return {
        address: {
          id: addressId,
          token,
          email: computeEmail(token),
          label: input.label ?? null,
          createdAt: now,
        },
      };
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
          email: computeEmail(address.token),
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
