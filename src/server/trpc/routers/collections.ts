/**
 * Collections Router
 *
 * Collections are subscriptions (#1806), so listing, renaming, tagging and
 * deleting one go through the subscriptions router; this router creates them
 * and changes their membership.
 */

import { z } from "zod";

import { createTRPCRouter, scopedProtectedProcedure } from "../trpc";
import { READER_SCOPES } from "@/server/auth/api-token";
import { uuidSchema } from "../validation";
import { unreadCountsSchema } from "@/lib/events/schemas";
import * as collectionsService from "@/server/services/collections";
import { subscriptionOutputSchema } from "./subscriptions";
import { COLLECTION_NAME_MAX_LENGTH, MAX_COLLECTION_BATCH } from "@/lib/collections";

// Part of the MCP tool surface; the native app uses it too.
const protectedProcedure = scopedProtectedProcedure(READER_SCOPES);

const collectionNameSchema = z
  .string()
  .trim()
  .min(1, "Collection name is required")
  .max(
    COLLECTION_NAME_MAX_LENGTH,
    `Collection name must be at most ${COLLECTION_NAME_MAX_LENGTH} characters`
  );

const entryIdsSchema = z.array(uuidSchema).min(1).max(MAX_COLLECTION_BATCH);

const membershipOutputSchema = z.object({
  entryIds: z.array(z.string()),
  counts: unreadCountsSchema.optional(),
});

export const collectionsRouter = createTRPCRouter({
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
    .output(z.object({ subscription: subscriptionOutputSchema, counts: unreadCountsSchema }))
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
    .input(z.object({ id: uuidSchema, entryIds: entryIdsSchema }))
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
    .input(z.object({ id: uuidSchema, entryIds: entryIdsSchema }))
    .output(membershipOutputSchema)
    .mutation(({ ctx, input }) =>
      collectionsService.removeEntriesFromCollection(
        ctx.db,
        ctx.session.user.id,
        input.id,
        input.entryIds
      )
    ),
});
