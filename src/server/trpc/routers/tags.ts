/**
 * Tags Router
 *
 * Handles tag CRUD operations for organizing subscriptions.
 * Each tag belongs to a single user and can be associated with multiple subscriptions.
 */

import { z } from "zod";
import { eq, and, sql, isNull } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { tags, subscriptionTags, subscriptions, entries, userEntries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Tag name validation schema.
 */
const tagNameSchema = z
  .string()
  .min(1, "Tag name is required")
  .max(50, "Tag name must be less than 50 characters")
  .trim();

/**
 * Tag color validation schema.
 * Accepts hex colors like #ff6b6b or null.
 */
const tagColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a valid hex color (e.g., #ff6b6b)")
  .nullable();

/**
 * UUID validation schema for tag IDs.
 */
const uuidSchema = z.string().uuid("Invalid tag ID");

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Tag output schema - what we return for a tag.
 */
const tagOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  feedCount: z.number(),
  unreadCount: z.number(),
  createdAt: z.date(),
});

// ============================================================================
// Router
// ============================================================================

export const tagsRouter = createTRPCRouter({
  /**
   * List all tags for the current user.
   *
   * Returns tags with their associated feed counts and unread counts.
   * Tags are ordered by name (ascending).
   */
  list: protectedProcedure
    .input(z.object({}).optional())
    .output(
      z.object({
        items: z.array(tagOutputSchema),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      // Get all tags for the user with feed counts and unread counts in a single query
      // Uses subqueries to avoid incorrect counts from JOIN multiplication
      // Note: We use "tags"."id" explicitly because ${tags.id} resolves to just "id"
      // which becomes ambiguous in subqueries with multiple tables that have id columns
      const userTags = await ctx.db
        .select({
          id: tags.id,
          name: tags.name,
          color: tags.color,
          createdAt: tags.createdAt,
          feedCount: sql<number>`(
            SELECT COUNT(*)::int
            FROM ${subscriptionTags}
            WHERE ${subscriptionTags.tagId} = "tags"."id"
          )`,
          unreadCount: sql<number>`(
            SELECT COUNT(*)::int
            FROM ${subscriptionTags} st
            INNER JOIN ${subscriptions} s
              ON st.subscription_id = s.id
              AND s.unsubscribed_at IS NULL
            INNER JOIN ${entries} e
              ON e.feed_id = ANY(s.feed_ids)
            INNER JOIN ${userEntries} ue
              ON ue.entry_id = e.id
              AND ue.user_id = ${userId}
              AND ue.read = false
            WHERE st.tag_id = "tags"."id"
          )`,
        })
        .from(tags)
        .where(eq(tags.userId, userId))
        .orderBy(tags.name);

      return {
        items: userTags.map((tag) => ({
          id: tag.id,
          name: tag.name,
          color: tag.color,
          feedCount: tag.feedCount,
          unreadCount: tag.unreadCount,
          createdAt: tag.createdAt,
        })),
      };
    }),

  /**
   * Create a new tag.
   *
   * @param name - The tag name (must be unique per user)
   * @param color - Optional hex color for the tag
   * @returns The created tag
   */
  create: protectedProcedure
    .input(
      z.object({
        name: tagNameSchema,
        color: tagColorSchema.optional(),
      })
    )
    .output(
      z.object({
        tag: tagOutputSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Attempt to create the tag - ON CONFLICT handles duplicates
      const tagId = generateUuidv7();
      const now = new Date();

      const result = await ctx.db
        .insert(tags)
        .values({
          id: tagId,
          userId,
          name: input.name,
          color: input.color ?? null,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({
          id: tags.id,
          name: tags.name,
          color: tags.color,
          createdAt: tags.createdAt,
        });

      // If no row returned, tag with this name already exists
      if (result.length === 0) {
        throw errors.validation("A tag with this name already exists");
      }

      return {
        tag: {
          id: result[0].id,
          name: result[0].name,
          color: result[0].color,
          feedCount: 0,
          unreadCount: 0,
          createdAt: result[0].createdAt,
        },
      };
    }),

  /**
   * Update a tag.
   *
   * @param id - The tag ID
   * @param name - Optional new name
   * @param color - Optional new color (or null to remove)
   * @returns The updated tag
   */
  update: protectedProcedure
    .input(
      z.object({
        id: uuidSchema,
        name: tagNameSchema.optional(),
        color: tagColorSchema.optional(),
      })
    )
    .output(
      z.object({
        tag: tagOutputSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Verify the tag exists and belongs to the user
      const existingTag = await ctx.db
        .select()
        .from(tags)
        .where(and(eq(tags.id, input.id), eq(tags.userId, userId)))
        .limit(1);

      if (existingTag.length === 0) {
        throw errors.tagNotFound();
      }

      // If name is being updated, check for duplicates
      if (input.name !== undefined && input.name !== existingTag[0].name) {
        const duplicateName = await ctx.db
          .select()
          .from(tags)
          .where(and(eq(tags.userId, userId), eq(tags.name, input.name)))
          .limit(1);

        if (duplicateName.length > 0) {
          throw errors.validation("A tag with this name already exists");
        }
      }

      // Build the update object
      const updateData: { name?: string; color?: string | null } = {};

      if (input.name !== undefined) {
        updateData.name = input.name;
      }

      if (input.color !== undefined) {
        updateData.color = input.color;
      }

      // Update the tag if there are changes
      if (Object.keys(updateData).length > 0) {
        await ctx.db.update(tags).set(updateData).where(eq(tags.id, input.id));
      }

      // Get updated tag with feed count and unread count concurrently
      const [updatedTag, unreadResult] = await Promise.all([
        ctx.db
          .select({
            id: tags.id,
            name: tags.name,
            color: tags.color,
            createdAt: tags.createdAt,
            feedCount: sql<number>`count(${subscriptionTags.subscriptionId})::int`,
          })
          .from(tags)
          .leftJoin(subscriptionTags, eq(subscriptionTags.tagId, tags.id))
          .where(and(eq(tags.id, input.id), eq(tags.userId, userId)))
          .groupBy(tags.id)
          .limit(1),
        ctx.db
          .select({
            unreadCount: sql<number>`count(*)::int`,
          })
          .from(subscriptionTags)
          .innerJoin(
            subscriptions,
            and(
              eq(subscriptionTags.subscriptionId, subscriptions.id),
              isNull(subscriptions.unsubscribedAt)
            )
          )
          .innerJoin(entries, sql`${entries.feedId} = ANY(${subscriptions.feedIds})`)
          .innerJoin(
            userEntries,
            and(
              eq(userEntries.entryId, entries.id),
              eq(userEntries.userId, userId),
              eq(userEntries.read, false)
            )
          )
          .where(eq(subscriptionTags.tagId, input.id)),
      ]);

      // This should never happen since we verified the tag exists above
      if (updatedTag.length === 0) {
        throw errors.tagNotFound();
      }

      return {
        tag: {
          id: updatedTag[0].id,
          name: updatedTag[0].name,
          color: updatedTag[0].color,
          feedCount: updatedTag[0].feedCount,
          unreadCount: unreadResult[0]?.unreadCount ?? 0,
          createdAt: updatedTag[0].createdAt,
        },
      };
    }),

  /**
   * Delete a tag.
   *
   * This will also remove all subscription_tags associations for this tag
   * (handled by the database CASCADE constraint).
   *
   * @param id - The tag ID
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

      // Delete the tag directly - RETURNING verifies it existed and belonged to user
      // (subscription_tags will cascade)
      const deleted = await ctx.db
        .delete(tags)
        .where(and(eq(tags.id, input.id), eq(tags.userId, userId)))
        .returning({ id: tags.id });

      if (deleted.length === 0) {
        throw errors.tagNotFound();
      }

      return { success: true };
    }),
});
