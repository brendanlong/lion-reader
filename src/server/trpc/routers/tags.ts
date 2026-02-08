/**
 * Tags Router
 *
 * Handles tag CRUD operations for organizing subscriptions.
 * Each tag belongs to a single user and can be associated with multiple subscriptions.
 * Delegates business logic to the tags service layer.
 */

import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { uuidSchema } from "../validation";
import * as tagsService from "@/server/services/tags";

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
    .meta({
      openapi: {
        method: "GET",
        path: "/tags",
        tags: ["Tags"],
        summary: "List tags",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        items: z.array(tagOutputSchema),
        uncategorized: z.object({
          feedCount: z.number(),
          unreadCount: z.number(),
        }),
      })
    )
    .query(async ({ ctx }) => {
      return tagsService.listTags(ctx.db, ctx.session.user.id);
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
        path: "/tags",
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
      const tag = await tagsService.createTag(ctx.db, ctx.session.user.id, {
        name: input.name,
        color: input.color,
      });
      return { tag };
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
        path: "/tags/{id}",
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
      const tag = await tagsService.updateTag(ctx.db, ctx.session.user.id, input.id, {
        name: input.name,
        color: input.color,
      });
      return { tag };
    }),

  /**
   * Delete a tag.
   *
   * Uses soft delete (sets deleted_at) for sync tracking. The tag remains in the
   * database but is excluded from queries. Subscription-tag associations are
   * removed immediately since they aren't tracked for sync.
   *
   * @param id - The tag ID
   * @returns Success status
   */
  delete: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/tags/{id}",
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
      await tagsService.deleteTag(ctx.db, ctx.session.user.id, input.id);
      return { success: true };
    }),
});
