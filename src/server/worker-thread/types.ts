/**
 * Message protocol for worker thread communication.
 *
 * Uses Zod for runtime validation of data crossing the thread boundary.
 * All values must be structured-clone-compatible (no class instances,
 * functions, or non-transferable objects).
 */

import { z } from "zod";
import type { ParsedFeed, ParsedEntry } from "@/server/feed/types";

// ---------------------------------------------------------------------------
// Requests (main thread → worker)
// ---------------------------------------------------------------------------

const cleanContentOptionsSchema = z.object({
  url: z.string().optional(),
  minContentLength: z.number().optional(),
  minCleanedLength: z.number().optional(),
});

const cleanContentRequestSchema = z.object({
  type: z.literal("cleanContent"),
  html: z.string(),
  options: cleanContentOptionsSchema.optional(),
});

const parseFeedRequestSchema = z.object({
  type: z.literal("parseFeed"),
  content: z.string(),
});

export const workerRequestSchema = z.discriminatedUnion("type", [
  cleanContentRequestSchema,
  parseFeedRequestSchema,
]);

export type WorkerRequest = z.infer<typeof workerRequestSchema>;
export type CleanContentOptions = z.infer<typeof cleanContentOptionsSchema>;

// ---------------------------------------------------------------------------
// Responses (worker → main thread)
// ---------------------------------------------------------------------------

export const cleanedContentSchema = z.object({
  content: z.string(),
  textContent: z.string(),
  excerpt: z.string(),
  title: z.string().nullable(),
  byline: z.string().nullable(),
});

export type CleanedContent = z.infer<typeof cleanedContentSchema>;

const syndicationHintsSchema = z.object({
  updatePeriod: z.enum(["hourly", "daily", "weekly", "monthly", "yearly"]).optional(),
  updateFrequency: z.number().optional(),
});

const serializedParsedEntrySchema = z.object({
  guid: z.string().optional(),
  link: z.string().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  content: z.string().optional(),
  summary: z.string().optional(),
  pubDate: z.string().optional(), // ISO 8601
});

export const serializedParsedFeedSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  siteUrl: z.string().optional(),
  iconUrl: z.string().optional(),
  hubUrl: z.string().optional(),
  selfUrl: z.string().optional(),
  ttlMinutes: z.number().optional(),
  syndication: syndicationHintsSchema.optional(),
  items: z.array(serializedParsedEntrySchema),
});

export type SerializedParsedFeed = z.infer<typeof serializedParsedFeedSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialise a ParsedFeed for transfer across the thread boundary. */
export function serializeParsedFeed(feed: ParsedFeed): SerializedParsedFeed {
  return {
    ...feed,
    items: feed.items.map((item) => ({
      ...item,
      pubDate: item.pubDate?.toISOString(),
    })),
  };
}

export type { ParsedFeed };

/** Restore Date objects after receiving a SerializedParsedFeed. */
export function deserializeParsedFeed(feed: SerializedParsedFeed): ParsedFeed {
  return {
    ...feed,
    syndication: feed.syndication as ParsedFeed["syndication"],
    items: feed.items.map(
      (item): ParsedEntry => ({
        ...item,
        pubDate: item.pubDate ? new Date(item.pubDate) : undefined,
      })
    ),
  };
}
