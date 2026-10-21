/**
 * Collections Router
 *
 * Collections are subscriptions (#1806), so listing, renaming, tagging and
 * deleting one go through the subscriptions router; this router creates them
 * and changes their membership and order.
 */

import { z } from "zod";

import { createTRPCRouter, scopedProtectedProcedure } from "../trpc";
import { READER_SCOPES } from "@/server/auth/api-token";
import {
  collectionEntryIdsSchema,
  collectionNameSchema,
  collectionPositionsSchema,
  uuidSchema,
} from "../validation";
import { unreadCountsSchema } from "@/lib/events/schemas";
import * as collectionsService from "@/server/services/collections";
import { subscriptionSchema } from "@/server/services/subscriptions";

// Part of the MCP tool surface; the native app uses it too.
const protectedProcedure = scopedProtectedProcedure(READER_SCOPES);

const membershipOutputSchema = z.object({
  entryIds: z.array(z.string()),
  counts: unreadCountsSchema.optional(),
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
