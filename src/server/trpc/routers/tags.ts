/**
 * Tags Router
 *
 * Handles tag CRUD operations for organizing subscriptions.
 * Each tag belongs to a single user and can be associated with multiple subscriptions.
 */

import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { tags, subscriptionTags } from "@/server/db/schema";
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
  createdAt: z.date(),
});

// ============================================================================
// Router
// ============================================================================

export const tagsRouter = createTRPCRouter({
  /**
   * List all tags for the current user.
   *
   * Returns tags with their associated feed counts.
   * Tags are ordered by name (ascending).
   */
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/v1/tags",
        tags: ["Tags"],
        summary: "List tags",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        items: z.array(tagOutputSchema),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      // Get all tags for the user with feed counts
      const userTags = await ctx.db
        .select({
          id: tags.id,
          name: tags.name,
          color: tags.color,
          createdAt: tags.createdAt,
          feedCount: sql<number>`count(${subscriptionTags.subscriptionId})::int`,
        })
        .from(tags)
        .leftJoin(subscriptionTags, eq(subscriptionTags.tagId, tags.id))
        .where(eq(tags.userId, userId))
        .groupBy(tags.id)
        .orderBy(tags.name);

      return {
        items: userTags.map((tag) => ({
          id: tag.id,
          name: tag.name,
          color: tag.color,
          feedCount: tag.feedCount,
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
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/tags",
        tags: ["Tags"],
        summary: "Create a tag",
      },
    })
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

      // Check if a tag with this name already exists for this user
      const existingTag = await ctx.db
        .select()
        .from(tags)
        .where(and(eq(tags.userId, userId), eq(tags.name, input.name)))
        .limit(1);

      if (existingTag.length > 0) {
        throw errors.validation("A tag with this name already exists");
      }

      // Create the tag
      const tagId = generateUuidv7();
      const now = new Date();

      await ctx.db.insert(tags).values({
        id: tagId,
        userId,
        name: input.name,
        color: input.color ?? null,
        createdAt: now,
      });

      return {
        tag: {
          id: tagId,
          name: input.name,
          color: input.color ?? null,
          feedCount: 0,
          createdAt: now,
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
    .meta({
      openapi: {
        method: "PATCH",
        path: "/v1/tags/{id}",
        tags: ["Tags"],
        summary: "Update a tag",
      },
    })
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

      // Get the updated tag with feed count
      const updatedTag = await ctx.db
        .select({
          id: tags.id,
          name: tags.name,
          color: tags.color,
          createdAt: tags.createdAt,
          feedCount: sql<number>`count(${subscriptionTags.subscriptionId})::int`,
        })
        .from(tags)
        .leftJoin(subscriptionTags, eq(subscriptionTags.tagId, tags.id))
        .where(eq(tags.id, input.id))
        .groupBy(tags.id)
        .limit(1);

      return {
        tag: {
          id: updatedTag[0].id,
          name: updatedTag[0].name,
          color: updatedTag[0].color,
          feedCount: updatedTag[0].feedCount,
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
    .meta({
      openapi: {
        method: "DELETE",
        path: "/v1/tags/{id}",
        tags: ["Tags"],
        summary: "Delete a tag",
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

      // Verify the tag exists and belongs to the user
      const existingTag = await ctx.db
        .select()
        .from(tags)
        .where(and(eq(tags.id, input.id), eq(tags.userId, userId)))
        .limit(1);

      if (existingTag.length === 0) {
        throw errors.tagNotFound();
      }

      // Delete the tag (subscription_tags will cascade)
      await ctx.db.delete(tags).where(eq(tags.id, input.id));

      return { success: true };
    }),
});
