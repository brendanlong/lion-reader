/**
 * Shared Zod Validation Schemas
 *
 * Input schemas used across tRPC routers, and by the MCP tools over the same
 * services so the two surfaces enforce the same limits. MCP adds
 * `.describe()`s.
 *
 * REST procedures swap each shared boolean for `booleanQueryParam`:
 * trpc-to-openapi sets `coerce` in place on the number and boolean schemas of
 * a REST procedure's input, so a plain `z.boolean()` there reads "false" as
 * true, and so would an MCP tool sharing that instance.
 */

import { z } from "zod";
import { TEXT_AI_PROVIDERS } from "@/lib/ai/providers";
import {
  COLLECTION_NAME_MAX_LENGTH,
  MAX_COLLECTION_BATCH,
  MAX_SAVE_COLLECTIONS,
} from "@/lib/collections";
import { ENTRY_TYPES } from "@/lib/entry-types";
import { MAX_ENTRIES_PAGE_SIZE } from "@/server/services/entries";
import { MAX_SUBSCRIPTIONS_PAGE_SIZE } from "@/server/services/subscriptions";
import { TAG_NAME_MAX_LENGTH } from "@/server/services/tags";

// ============================================================================
// ID Schemas
// ============================================================================

/**
 * UUID validation schema for entity IDs.
 */
export const uuidSchema = z.string().uuid("Invalid ID");

/**
 * A boolean that also takes the strings "true" and "false", as a REST query
 * string carries it.
 */
export const booleanQueryParam = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .optional()
  .transform((val) => {
    if (val === "true") return true;
    if (val === "false") return false;
    return val;
  });

// ============================================================================
// Entry Schemas
// ============================================================================

/** Filters and paging of an entry list (`listEntries`). */
export const entryListInputSchema = z.object({
  query: z.string().optional(),
  subscriptionId: uuidSchema.optional(),
  tagId: uuidSchema.optional(),
  uncategorized: z.boolean().optional(),
  type: z.enum(ENTRY_TYPES).optional(),
  unreadOnly: z.boolean().optional(),
  starredOnly: z.boolean().optional(),
  sortOrder: z.enum(["newest", "oldest"]).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_ENTRIES_PAGE_SIZE).optional(),
});

/**
 * The one list `countEntries` counts. Strict, so a filter it has no counter
 * for (excludeTypes, readOnly, ...) fails instead of being dropped into a
 * different list's count.
 */
export const entryCountInputSchema = z.strictObject({
  subscriptionId: uuidSchema.optional(),
  tagId: uuidSchema.optional(),
  uncategorized: z.boolean().optional(),
  type: z.enum(["saved"]).optional(),
  starredOnly: z.boolean().optional(),
});

// ============================================================================
// Subscription Schemas
// ============================================================================

/** Filters and paging of the subscription list (`listSubscriptions`). */
export const subscriptionListInputSchema = z.object({
  /** Case-insensitive substring of the title. */
  query: z.string().optional(),
  tagId: uuidSchema.optional(),
  uncategorized: z.boolean().optional(),
  unreadOnly: z.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_SUBSCRIPTIONS_PAGE_SIZE).optional(),
});

/** Most tags one call may set on a subscription. */
const MAX_SUBSCRIPTION_TAGS = 100;

/** A subscription's complete set of tags. */
export const subscriptionTagIdsSchema = z.array(uuidSchema).max(MAX_SUBSCRIPTION_TAGS);

// ============================================================================
// Tag Schemas
// ============================================================================

/** Trimmed first, like the tags service, so padding doesn't count. */
export const tagNameSchema = z
  .string()
  .trim()
  .min(1, "Tag name is required")
  .max(TAG_NAME_MAX_LENGTH, `Tag name must be at most ${TAG_NAME_MAX_LENGTH} characters`);

/**
 * Tag color validation schema.
 * Accepts hex colors like #ff6b6b or null (tag colors are rendered into
 * inline styles).
 */
export const tagColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a valid hex color (e.g., #ff6b6b)")
  .nullable();

// ============================================================================
// Collection Schemas
// ============================================================================

export const collectionNameSchema = z
  .string()
  .trim()
  .min(1, "Collection name is required")
  .max(
    COLLECTION_NAME_MAX_LENGTH,
    `Collection name must be at most ${COLLECTION_NAME_MAX_LENGTH} characters`
  );

/** The entries one add-to or remove-from-collection call names. */
export const collectionEntryIdsSchema = z.array(uuidSchema).min(1).max(MAX_COLLECTION_BATCH);

// ============================================================================
// Saved Article Schemas
// ============================================================================

export const savedArticleUrlSchema = z.url("Invalid URL");

/** Collections to put a newly saved article in; checked before saving. */
export const saveCollectionIdsSchema = z.array(uuidSchema).max(MAX_SAVE_COLLECTIONS).optional();

// ============================================================================
// URL Schemas
// ============================================================================

/**
 * URL validation schema for feed/subscription URLs.
 *
 * Validates:
 * - Required (non-empty)
 * - Max 2048 characters (reasonable URL limit)
 * - Valid URL format
 * - Must use http or https protocol
 */
export const feedUrlSchema = z
  .string()
  .min(1, "URL is required")
  .max(2048, "URL must be less than 2048 characters")
  .url("Invalid URL format")
  .refine((url) => url.startsWith("http://") || url.startsWith("https://"), {
    message: "URL must use http or https protocol",
  });

// ============================================================================
// AI Model Schemas
// ============================================================================

/**
 * A model listed for a feature's model picker (summarization, narration).
 */
export const aiModelListSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      provider: z.enum(TEXT_AI_PROVIDERS),
      contextLength: z.number().optional(),
      inputPricePerMillion: z.number().optional(),
      outputPricePerMillion: z.number().optional(),
    })
  ),
  defaultModelId: z.string(),
});
