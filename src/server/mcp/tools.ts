/**
 * MCP Tool Definitions
 *
 * Defines the tools (functions) available to AI assistants via MCP.
 * Each tool wraps service layer functions with MCP-specific interfaces.
 *
 * Tool arguments are validated with Zod before reaching the services layer:
 * the advertised `inputSchema` is generated from the same Zod schema that the
 * handler enforces, so the two can never drift. Unknown keys are stripped, so
 * clients can't smuggle internal service parameters (e.g. `maxLimit`,
 * `userId`) through the tool call.
 */

import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { TRPCError } from "@trpc/server";
import type { db as dbType } from "@/server/db";
import { uuidSchema, tagColorSchema } from "@/server/trpc/validation";
import { getAppErrorCode } from "@/server/trpc/errors";
import * as entriesService from "@/server/services/entries";
import * as subscriptionsService from "@/server/services/subscriptions";
import * as savedService from "@/server/services/saved";
import * as tagsService from "@/server/services/tags";
import * as collectionsService from "@/server/services/collections";
import {
  COLLECTION_NAME_MAX_LENGTH,
  MAX_COLLECTION_BATCH,
  MAX_SAVE_COLLECTIONS,
} from "@/lib/collections";

// ============================================================================
// Types
// ============================================================================

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (db: typeof dbType, userId: string, args: unknown) => Promise<unknown>;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Parses tool arguments against a Zod schema, converting failures into MCP
 * InvalidParams errors so clients get a useful message instead of a 500.
 */
function parseArgs<T extends z.ZodType>(schema: T, args: unknown): z.infer<T> {
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments: ${z.prettifyError(result.error)}`
    );
  }
  return result.data;
}

/**
 * Convert service-layer errors into structured MCP errors. Services throw
 * TRPCErrors (their native error type across all transports).
 *
 * Messages of errors carrying an app code (`errors.*` and the services'
 * hand-built errors with a `cause.code`) are written for users, so they're
 * forwarded with the app code in `data.code` — an agent needs to tell "this
 * site is rate limiting us" (#1834) apart from our bug, and JSON-RPC has no
 * error codes that make that distinction. INTERNAL_SERVER_ERROR and errors
 * without an app code get a generic string instead: an unexpected server
 * error's message can leak internal detail (#1266). Callers are responsible
 * for logging the original error server-side before mapping.
 */
export function toMcpError(error: unknown): unknown {
  if (error instanceof McpError) {
    return error;
  }
  if (error instanceof TRPCError) {
    const isClientInput = error.code === "BAD_REQUEST" || error.code === "NOT_FOUND";
    const mcpCode = isClientInput ? ErrorCode.InvalidParams : ErrorCode.InternalError;
    const appCode = getAppErrorCode(error);
    if (appCode !== undefined && error.code !== "INTERNAL_SERVER_ERROR") {
      return new McpError(mcpCode, error.message, { code: appCode });
    }
    if (isClientInput) {
      return new McpError(mcpCode, error.message);
    }
    return new McpError(ErrorCode.InternalError, "An internal error occurred");
  }
  return error;
}

/**
 * Strips the Google Reader-internal compat ids (`greaderItemId` and the feed
 * stream serials) from an entry before it reaches an MCP response. They are
 * bigints, which the transports' `JSON.stringify` can't serialize (it throws),
 * and they're meaningless to MCP clients — only the Google Reader compat layer
 * consumes them. The tRPC/REST surfaces strip them via their Zod output schemas;
 * MCP serializes service results directly, so they must be dropped here.
 */
function stripGreaderIds<
  T extends {
    greaderItemId: bigint;
    subscriptionGreaderStreamId: bigint | null;
    feedGreaderStreamId: bigint;
  },
>(entry: T): Omit<T, "greaderItemId" | "subscriptionGreaderStreamId" | "feedGreaderStreamId"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { greaderItemId, subscriptionGreaderStreamId, feedGreaderStreamId, ...rest } = entry;
  return rest;
}

/**
 * Drops the article body from save/upload results: agents need the id and
 * metadata, and a long page's body can exceed client tool-output limits
 * (#1835). `get_entry` returns the full content.
 */
function withoutContent<T extends savedService.SavedArticle>(
  article: T
): Omit<T, "contentCleaned"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { contentCleaned, ...rest } = article;
  return rest;
}

/**
 * Derives the advertised MCP inputSchema from the Zod schema so the schema
 * clients see is exactly the one the handler enforces.
 */
function toInputSchema(schema: z.ZodType): Tool["inputSchema"] {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json as unknown as Tool["inputSchema"];
}

// ============================================================================
// Argument Schemas
// ============================================================================

const listEntriesArgs = z.object({
  query: z
    .string()
    .optional()
    .describe("Full-text search query over entry title and content (relevance-ranked)"),
  subscriptionId: uuidSchema
    .optional()
    .describe("Filter by subscription ID (a feed or a collection)"),
  tagId: uuidSchema.optional().describe("Filter by tag ID"),
  uncategorized: z.boolean().optional().describe("Show only uncategorized entries"),
  type: z.enum(["web", "email", "saved"]).optional().describe("Filter by entry type"),
  unreadOnly: z.boolean().optional().describe("Show only unread entries"),
  readOnly: z.boolean().optional().describe("Show only read entries"),
  starredOnly: z.boolean().optional().describe("Show only starred entries"),
  unstarredOnly: z.boolean().optional().describe("Show only unstarred entries"),
  sortOrder: z.enum(["newest", "oldest"]).optional().describe("Sort order (default: newest)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of entries per page (max 100)"),
  cursor: z.string().optional().describe("Pagination cursor from previous response"),
});

const getEntryArgs = z.object({
  entryId: uuidSchema.describe("Entry ID"),
});

const markEntriesReadArgs = z.object({
  entryIds: z.array(uuidSchema).min(1).max(1000).describe("Array of entry IDs to mark"),
  read: z.boolean().describe("Mark as read (true) or unread (false)"),
});

const starEntriesArgs = z.object({
  entryId: uuidSchema.describe("Entry ID"),
  starred: z.boolean().describe("Star (true) or unstar (false)"),
});

const countEntriesArgs = z.object({
  subscriptionId: uuidSchema
    .optional()
    .describe("Filter by subscription ID (a feed or a collection)"),
  tagId: uuidSchema.optional().describe("Filter by tag ID"),
  uncategorized: z.boolean().optional().describe("Count only uncategorized entries"),
  type: z.enum(["web", "email", "saved"]).optional().describe("Filter by entry type"),
  unreadOnly: z.boolean().optional().describe("Count only unread entries"),
  readOnly: z.boolean().optional().describe("Count only read entries"),
  starredOnly: z.boolean().optional().describe("Count only starred entries"),
  unstarredOnly: z.boolean().optional().describe("Count only unstarred entries"),
});

const saveCollectionIdsArg = z
  .array(uuidSchema)
  .max(MAX_SAVE_COLLECTIONS)
  .optional()
  .describe("Optional collection IDs to also add the article to (see create_collection)");

const saveArticleArgs = z.object({
  url: z.url().describe("The URL to save"),
  title: z
    .string()
    .optional()
    .describe(
      "Optional title override (useful if page title is poor). Plain text (NOT " +
        "Markdown or HTML). Do NOT HTML-escape it — write & not &amp;, since it is " +
        "rendered as literal text and an entity like &amp; would show up verbatim."
    ),
  author: z
    .string()
    .optional()
    .describe(
      "Optional author/byline override (useful if you already know it better than " +
        "the page). Plain text (NOT Markdown or HTML). Do NOT HTML-escape it — write " +
        "& not &amp;, since it is rendered as literal text."
    ),
  summary: z
    .string()
    .optional()
    .describe(
      "Optional summary/excerpt override (e.g. an abstract you already have). Plain " +
        "text (NOT Markdown or HTML). Do NOT HTML-escape it — write & not &amp;, since " +
        "it is rendered as literal text. Clipped to ~300 characters."
    ),
  collectionIds: saveCollectionIdsArg,
});

const deleteSavedArticleArgs = z.object({
  articleId: uuidSchema.describe("The saved article ID to delete"),
});

const uploadArticleArgs = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      "Article content in GitHub Flavored Markdown. Supports footnotes ([^1] … [^1]: …) " +
        "and math ($…$ inline, $$…$$ display). Standard CommonMark: raw characters and " +
        "HTML entities both work in the body (& and &amp; both render as &)."
    ),
  title: z
    .string()
    .min(1)
    .describe(
      "Article title as plain text (NOT Markdown or HTML). Do NOT HTML-escape it — write " +
        "& not &amp;, since the title is rendered as literal text and an entity like " +
        "&amp; would show up verbatim."
    ),
  author: z
    .string()
    .optional()
    .describe(
      "Optional author/byline override. Plain text (NOT Markdown or HTML). Do NOT " +
        "HTML-escape it — write & not &amp;, since it is rendered as literal text."
    ),
  summary: z
    .string()
    .optional()
    .describe(
      "Optional summary/excerpt override (e.g. an abstract you already have). Plain " +
        "text (NOT Markdown or HTML). Do NOT HTML-escape it — write & not &amp;, since " +
        "it is rendered as literal text. Clipped to ~300 characters."
    ),
  collectionIds: saveCollectionIdsArg,
});

const listSubscriptionsArgs = z.object({
  query: z.string().optional().describe("Case-insensitive title search (substring matching)"),
  tagId: uuidSchema.optional().describe("Filter by tag ID"),
  unreadOnly: z.boolean().optional().describe("Only show feeds with unread items"),
  type: z
    .enum(["web", "email", "collection"])
    .optional()
    .describe("Only show this kind: web feeds, newsletters, or collections"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of subscriptions per page (max 100)"),
  cursor: z.string().optional().describe("Pagination cursor from previous response"),
});

const getSubscriptionArgs = z.object({
  subscriptionId: uuidSchema.describe("Subscription ID"),
});

const setSubscriptionTagsArgs = z.object({
  subscriptionId: uuidSchema.describe("Subscription ID (a feed or a collection)"),
  tagIds: z
    .array(uuidSchema)
    .max(100)
    .describe("The complete set of tag IDs it should have; an empty array removes all tags"),
});

const createCollectionArgs = z.object({
  name: z.string().trim().min(1).max(COLLECTION_NAME_MAX_LENGTH).describe("Collection name"),
});

const collectionEntriesArgs = z.object({
  collectionId: uuidSchema.describe(
    "The collection's subscription ID (list_subscriptions shows collections with type 'collection')"
  ),
  entryIds: z.array(uuidSchema).min(1).max(MAX_COLLECTION_BATCH).describe("Entry IDs"),
});

const listTagsArgs = z.object({});

const createTagArgs = z.object({
  name: z.string().min(1).max(50).describe("Tag name (max 50 characters, must be unique per user)"),
  color: tagColorSchema
    .optional()
    .describe("Optional hex color (e.g., #ff6b6b). Null to remove color."),
});

const updateTagArgs = z.object({
  tagId: uuidSchema.describe("Tag ID"),
  name: z
    .string()
    .min(1)
    .max(50)
    .optional()
    .describe("New tag name (max 50 characters, must be unique per user)"),
  color: tagColorSchema.optional().describe("New hex color (e.g., #ff6b6b). Null to remove color."),
});

const deleteTagArgs = z.object({
  tagId: uuidSchema.describe("Tag ID to delete"),
});

// ============================================================================
// Tool Definitions
// ============================================================================

/**
 * Registers all available MCP tools.
 * Each tool wraps a service function with MCP-compatible interface.
 *
 * The tool list is static (handlers take db/userId as parameters), so it is
 * built once per process — the stateless MCP HTTP route calls this on every
 * request, and rebuilding would re-run every z.toJSONSchema conversion.
 */
export function registerTools(): Tool[] {
  cachedTools ??= buildTools();
  return cachedTools;
}

let cachedTools: Tool[] | null = null;

function buildTools(): Tool[] {
  return [
    // ========================================================================
    // Entries Tools
    // ========================================================================

    {
      name: "list_entries",
      description:
        "List feed entries with filters and pagination, sorted by time (or by relevance when `query` is given for full-text search). Returns summaries (title, snippet) without full content.",
      inputSchema: toInputSchema(listEntriesArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(listEntriesArgs, args);
        const result = await entriesService.listEntries(db, {
          userId,
          ...params,
          showSpam: false, // Default to hiding spam for MCP
        });
        return { ...result, items: result.items.map(stripGreaderIds) };
      },
    },

    {
      name: "get_entry",
      description: "Get a single entry with full content (original and cleaned HTML).",
      inputSchema: toInputSchema(getEntryArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(getEntryArgs, args);
        const entry = await entriesService.getEntry(db, userId, params.entryId);
        return entry ? stripGreaderIds(entry) : entry;
      },
    },

    {
      name: "mark_entries_read",
      description:
        "Mark entries as read or unread (bulk operation, max 1000). Returns updated entries and unread counts.",
      inputSchema: toInputSchema(markEntriesReadArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(markEntriesReadArgs, args);
        // markEntriesRead computes the counts and publishes entry_state_changed
        // for multi-tab/device sync itself, mirroring the tRPC mutation.
        const { entries, counts } = await entriesService.markEntriesRead(
          db,
          userId,
          params.entryIds.map((id) => ({ id })),
          params.read
        );

        return { entries, counts };
      },
    },

    {
      name: "star_entries",
      // Single-entry, unlike mark_entries_read: the schema takes one `entryId`
      // (and `toInputSchema` emits `additionalProperties: false`, so an `entryIds`
      // array is an InvalidParams error, not a bulk call). The tool name is part
      // of the published MCP surface, so it stays as-is.
      description: "Star or unstar an entry. Starred entries remain visible after unsubscribing.",
      inputSchema: toInputSchema(starEntriesArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(starEntriesArgs, args);
        // updateEntryStarred computes the counts and publishes
        // entry_state_changed for multi-tab/device sync itself, mirroring the
        // tRPC entries.setStarred mutation.
        const { entry } = await entriesService.updateEntryStarred(
          db,
          userId,
          params.entryId,
          params.starred
        );

        return entry;
      },
    },

    {
      name: "count_entries",
      description: "Get count of entries with filters. Returns total and unread counts.",
      inputSchema: toInputSchema(countEntriesArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(countEntriesArgs, args);
        return entriesService.countEntries(db, userId, params);
      },
    },

    // ========================================================================
    // Saved Articles Tools
    // ========================================================================

    {
      name: "save_article",
      description:
        "Save a URL for later reading. Fetches the page, extracts clean content using Readability, and stores it. Returns the saved article's metadata and excerpt (not its content; use get_entry for that), including when it was already saved. Private Google Docs are supported when the user has linked their Google account and granted Google Docs access in the web app; otherwise a clear error explains how to authorize.",
      inputSchema: toInputSchema(saveArticleArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(saveArticleArgs, args);
        await collectionsService.assertOwnedCollections(db, userId, params.collectionIds ?? []);
        const article = await savedService.saveArticle(db, userId, {
          url: params.url,
          title: params.title,
          author: params.author,
          excerpt: params.summary,
          // Use the user's stored Google credentials for private Google Docs
          // when already linked/granted; otherwise throw a clear error telling
          // them to authorize Google Docs access in the web app (an MCP client
          // can't run the interactive consent flow).
          googleDocsAuth: "non-interactive",
        });
        await collectionsService.addEntryToCollections(
          db,
          userId,
          article.id,
          params.collectionIds ?? []
        );
        return withoutContent(article);
      },
    },

    {
      name: "delete_saved_article",
      description: "Delete a saved article. Returns success status.",
      inputSchema: toInputSchema(deleteSavedArticleArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(deleteSavedArticleArgs, args);
        const deleted = await savedService.deleteSavedArticle(db, userId, params.articleId);
        return { deleted };
      },
    },

    {
      name: "upload_article",
      description:
        "Upload an article with Markdown content directly, without a URL. Useful for saving content you've written or collected. Returns the saved article's metadata and excerpt (not its content).",
      inputSchema: toInputSchema(uploadArticleArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(uploadArticleArgs, args);
        await collectionsService.assertOwnedCollections(db, userId, params.collectionIds ?? []);
        const article = await savedService.uploadArticle(db, userId, {
          content: params.content,
          title: params.title,
          author: params.author,
          excerpt: params.summary,
        });
        await collectionsService.addEntryToCollections(
          db,
          userId,
          article.id,
          params.collectionIds ?? []
        );
        return withoutContent(article);
      },
    },

    // ========================================================================
    // Subscriptions Tools
    // ========================================================================

    {
      name: "list_subscriptions",
      description:
        "List active subscriptions — feeds, newsletters and collections (type 'collection') — with optional filtering and pagination. Supports case-insensitive title search, tag, type and unread-only filtering, and cursor-based pagination.",
      inputSchema: toInputSchema(listSubscriptionsArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(listSubscriptionsArgs, args);
        return subscriptionsService.listSubscriptions(db, {
          userId,
          ...params,
        });
      },
    },

    {
      name: "get_subscription",
      description: "Get details for a single subscription including unread count and tags.",
      inputSchema: toInputSchema(getSubscriptionArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(getSubscriptionArgs, args);
        return subscriptionsService.getSubscription(db, userId, params.subscriptionId);
      },
    },

    {
      name: "set_subscription_tags",
      description:
        "Replace the tags on a subscription (a feed or a collection). Tags group feeds and " +
        "collections in the sidebar; one subscription can have several tags.",
      inputSchema: toInputSchema(setSubscriptionTagsArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(setSubscriptionTagsArgs, args);
        await subscriptionsService.setSubscriptionTags(
          db,
          userId,
          params.subscriptionId,
          params.tagIds
        );
        return { success: true };
      },
    },

    // ========================================================================
    // Collections Tools
    // ========================================================================

    {
      name: "create_collection",
      description:
        "Create a collection: a list of articles you fill by hand, shown and tagged like a " +
        "feed. Returns it as a subscription; its id is the collectionId for " +
        "add_to_collection and the subscriptionId for list_entries and set_subscription_tags.",
      inputSchema: toInputSchema(createCollectionArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(createCollectionArgs, args);
        const { subscription } = await collectionsService.createCollection(db, userId, params.name);
        return subscription;
      },
    },

    {
      name: "add_to_collection",
      description:
        "Add articles to a collection. Any visible article works (feed entries or saved " +
        "articles); it stays in its own feed too, sharing read and starred state. Returns " +
        "the IDs newly added (already-present and unknown IDs are skipped).",
      inputSchema: toInputSchema(collectionEntriesArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(collectionEntriesArgs, args);
        const { entryIds } = await collectionsService.addEntriesToCollection(
          db,
          userId,
          params.collectionId,
          params.entryIds
        );
        return { entryIds };
      },
    },

    {
      name: "remove_from_collection",
      description:
        "Remove articles from a collection. The articles themselves are not deleted. Returns " +
        "the IDs actually removed.",
      inputSchema: toInputSchema(collectionEntriesArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(collectionEntriesArgs, args);
        const { entryIds } = await collectionsService.removeEntriesFromCollection(
          db,
          userId,
          params.collectionId,
          params.entryIds
        );
        return { entryIds };
      },
    },

    // ========================================================================
    // Tags Tools
    // ========================================================================

    {
      name: "list_tags",
      description:
        "List all tags with feed counts and unread counts. Also returns uncategorized subscription counts.",
      inputSchema: toInputSchema(listTagsArgs),
      handler: async (db, userId, args) => {
        parseArgs(listTagsArgs, args);
        return tagsService.listTags(db, userId);
      },
    },

    {
      name: "create_tag",
      description: "Create a new tag for organizing subscriptions.",
      inputSchema: toInputSchema(createTagArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(createTagArgs, args);
        return tagsService.createTag(db, userId, {
          name: params.name,
          color: params.color,
        });
      },
    },

    {
      name: "update_tag",
      description: "Update an existing tag's name or color.",
      inputSchema: toInputSchema(updateTagArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(updateTagArgs, args);
        return tagsService.updateTag(db, userId, params.tagId, {
          name: params.name,
          color: params.color,
        });
      },
    },

    {
      name: "delete_tag",
      description:
        "Delete a tag. Uses soft delete for sync tracking. Subscription-tag associations are removed immediately.",
      inputSchema: toInputSchema(deleteTagArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(deleteTagArgs, args);
        await tagsService.deleteTag(db, userId, params.tagId);
        return { success: true };
      },
    },
  ];
}
