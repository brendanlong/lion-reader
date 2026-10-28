/**
 * Collections Router
 *
 * Collections are subscriptions (#1806), so listing, renaming and tagging one
 * go through the subscriptions router; this router creates and deletes them
 * and changes their membership and order. Deleting is here because, unlike
 * `subscriptions.delete`, it's open to tokens.
 */

import { z } from "zod";

import { createTRPCRouter, scopedProtectedProcedure } from "../trpc";
import { READER_SCOPES } from "@/server/auth/api-token";
import {
  booleanQueryParam,
  collectionEntryIdsSchema,
  collectionNameSchema,
  collectionPositionsSchema,
  uploadContentSchema,
  uuidSchema,
} from "../validation";
import { entryTagListsSchema, unreadCountsSchema } from "@/lib/events/schemas";
import * as collectionsService from "@/server/services/collections";
import * as ebooksService from "@/server/services/ebooks";
import { subscriptionSchema } from "@/server/services/subscriptions";

// Part of the MCP tool surface; the native app uses it too.
const protectedProcedure = scopedProtectedProcedure(READER_SCOPES);

const membershipOutputSchema = z.object({
  entryIds: z.array(z.string()),
  counts: unreadCountsSchema.optional(),
  tagLists: entryTagListsSchema,
});

export const collectionsRouter = createTRPCRouter({
  /**
   * Create a collection. Active collections' names are unique per user
   * ignoring case; creating an existing name returns that collection
   * unchanged with `created: false`.
   */
  create: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/collections",
        tags: ["Collections"],
        summary: "Create a collection",
      },
    })
    .input(z.object({ name: collectionNameSchema }))
    .output(
      z.object({
        subscription: subscriptionSchema,
        counts: unreadCountsSchema,
        created: z.boolean(),
      })
    )
    .mutation(({ ctx, input }) =>
      collectionsService.createCollection(ctx.db, ctx.session.user.id, input.name)
    ),

  /**
   * Delete a collection. Its articles stay in their feeds and in Saved, unless
   * `deleteSavedArticles`: then saved articles in no other collection are
   * deleted too.
   */
  delete: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/collections/{id}",
        tags: ["Collections"],
        summary: "Delete a collection",
      },
    })
    .input(z.object({ id: uuidSchema, deleteSavedArticles: booleanQueryParam }))
    .output(z.object({ counts: unreadCountsSchema }))
    .mutation(({ ctx, input }) =>
      collectionsService.deleteCollection(ctx.db, ctx.session.user.id, input.id, {
        deleteSavedArticles: input.deleteSavedArticles,
      })
    ),

  /**
   * Import an `.epub` as a collection named for the book, with each chapter
   * as an article positioned in reading order. Like `create`, an existing
   * collection with the book's name is reused (`created: false`).
   */
  importEbook: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/collections/import-ebook",
        tags: ["Collections"],
        summary: "Import an ebook as a collection",
      },
    })
    .input(
      z.object({
        content: uploadContentSchema,
        filename: z.string().min(1, "Filename is required"),
      })
    )
    .output(
      z.object({
        subscription: subscriptionSchema,
        created: z.boolean(),
        entryIds: z.array(z.string()),
        counts: unreadCountsSchema,
      })
    )
    .mutation(({ ctx, input }) => ebooksService.importEbook(ctx.db, ctx.session.user.id, input)),

  listForEntry: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/entries/{entryId}/collections",
        tags: ["Collections"],
        summary: "List the collections holding an article",
      },
    })
    .input(z.object({ entryId: uuidSchema }))
    .output(z.object({ collectionIds: z.array(z.string()) }))
    .query(async ({ ctx, input }) => ({
      collectionIds: await collectionsService.listEntryCollectionIds(
        ctx.db,
        ctx.session.user.id,
        input.entryId
      ),
    })),

  /** Adds articles the user can see; others are skipped. Returns the ones newly added. */
  addEntries: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/collections/{id}/entries",
        tags: ["Collections"],
        summary: "Add articles to a collection",
      },
    })
    .input(z.object({ id: uuidSchema, entryIds: collectionEntryIdsSchema }))
    .output(membershipOutputSchema)
    .mutation(({ ctx, input }) =>
      collectionsService.addEntriesToCollection(
        ctx.db,
        ctx.session.user.id,
        input.id,
        input.entryIds
      )
    ),

  /** Returns the articles that were actually removed. */
  removeEntries: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/collections/{id}/entries/remove",
        tags: ["Collections"],
        summary: "Remove articles from a collection",
      },
    })
    .input(z.object({ id: uuidSchema, entryIds: collectionEntryIdsSchema }))
    .output(membershipOutputSchema)
    .mutation(({ ctx, input }) =>
      collectionsService.removeEntriesFromCollection(
        ctx.db,
        ctx.session.user.id,
        input.id,
        input.entryIds
      )
    ),

  /**
   * Sets or clears articles' positions in a collection (#2064), its order when
   * sorted by position. Articles not in the collection are skipped and returned.
   */
  setPositions: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/collections/{id}/positions",
        tags: ["Collections"],
        summary: "Set the order of a collection's articles",
      },
    })
    .input(z.object({ id: uuidSchema, positions: collectionPositionsSchema }))
    .output(z.object({ changedIds: z.array(z.string()), notInCollectionIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) =>
      collectionsService.setCollectionPositions(
        ctx.db,
        ctx.session.user.id,
        input.id,
        input.positions
      )
    ),
});
