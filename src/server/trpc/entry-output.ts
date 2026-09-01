/**
 * Shared entry output schemas — the single definition of the entry shapes the
 * app's API surfaces return.
 *
 * The tRPC/REST entries router uses these as `.output()` schemas, and the MCP
 * tools parse service results through them before serializing. Parsing here is
 * what strips service-internal fields (notably the Google Reader compat
 * bigints, which `JSON.stringify` can't serialize) — one contract instead of a
 * per-surface strip helper that can drift.
 */

import { z } from "zod";

const feedTypeSchema = z.enum(["web", "email", "saved"]);

/**
 * Lightweight entry output schema for list views (no full content).
 * Matches the service layer's `EntryListItem` minus the compat-only ids.
 */
export const entryListItemSchema = z.object({
  id: z.string(),
  subscriptionId: z.string().nullable(), // null for orphaned starred entries
  feedId: z.string(), // Internal use only - kept for cache invalidation
  type: feedTypeSchema,
  url: z.string().nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  summary: z.string().nullable(),
  publishedAt: z.date().nullable(),
  fetchedAt: z.date(),
  read: z.boolean(),
  starred: z.boolean(),
  updatedAt: z.date(), // Max of entry and user state updated_at - for cache freshness
  feedTitle: z.string().nullable(),
  siteName: z.string().nullable(),
});

/**
 * Paginated entries list output schema.
 */
export const entriesListOutputSchema = z.object({
  items: z.array(entryListItemSchema),
  nextCursor: z.string().optional(),
});

/**
 * Full entry with sanitized content — the service layer's `EntryFull` shape
 * (returned by `getEntry`/`getEntries`, used directly by MCP) minus the
 * compat-only ids. The tRPC `entries.get` output extends this with the
 * full-content fields resolved by `selectFullEntry`/`toFullEntry`.
 */
export const entryFullCoreSchema = z.object({
  id: z.string(),
  subscriptionId: z.string().nullable(), // null for orphaned starred entries
  feedId: z.string(), // Internal use only - kept for cache invalidation
  type: feedTypeSchema,
  url: z.string().nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  contentOriginal: z.string().nullable(),
  contentCleaned: z.string().nullable(),
  summary: z.string().nullable(),
  publishedAt: z.date().nullable(),
  fetchedAt: z.date(),
  read: z.boolean(),
  starred: z.boolean(),
  updatedAt: z.date(), // Max of entry and user state updated_at - for cache freshness
  feedTitle: z.string().nullable(),
  feedUrl: z.string().nullable(),
  siteName: z.string().nullable(),
  // Unsubscribe link from email HTML (for email entries)
  unsubscribeUrl: z.string().nullable(),
});
