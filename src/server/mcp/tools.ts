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
import { eq } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { users } from "@/server/db/schema";
import {
  collectionEntryIdsSchema,
  collectionNameSchema,
  entryCountInputSchema,
  entryListInputSchema,
  savedArticleUrlSchema,
  saveCollectionIdsSchema,
  subscriptionListInputSchema,
  subscriptionTagIdsSchema,
  tagColorSchema,
  tagNameSchema,
  uuidSchema,
} from "@/server/trpc/validation";
import { getAppErrorCode } from "@/server/errors";
import * as entriesService from "@/server/services/entries";
import * as entryReadsService from "@/server/services/entry-reads";
import * as entryStateService from "@/server/services/entry-state";
import * as subscriptionUpdatesService from "@/server/services/subscription-updates";
import * as subscriptionsService from "@/server/services/subscriptions";
import * as savedService from "@/server/services/saved";
import * as tagsService from "@/server/services/tags";
import * as collectionsService from "@/server/services/collections";

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

const entryList = entryListInputSchema().shape;
const listEntriesArgs = entryListInputSchema().extend({
  query: entryList.query.describe(
    "Full-text search query over entry title and content (relevance-ranked)"
  ),
  subscriptionId: entryList.subscriptionId.describe(
    "Filter by subscription ID (a feed, a collection or Saved)"
  ),
  tagId: entryList.tagId.describe("Filter by tag ID"),
  uncategorized: entryList.uncategorized.describe("Show only uncategorized entries"),
  type: entryList.type.describe("Filter by entry type"),
  unreadOnly: entryList.unreadOnly.describe("Show only unread entries"),
  readOnly: z.boolean().optional().describe("Show only read entries"),
  starredOnly: entryList.starredOnly.describe("Show only starred entries"),
  unstarredOnly: z.boolean().optional().describe("Show only unstarred entries"),
  sortOrder: entryList.sortOrder.describe("Sort order (default: newest)"),
  limit: entryList.limit.describe(
    `Number of entries per page (max ${entriesService.MAX_ENTRIES_PAGE_SIZE})`
  ),
  cursor: entryList.cursor.describe("Pagination cursor from previous response"),
});

const getEntryArgs = z.object({
  entryId: uuidSchema.describe("Entry ID"),
});

const markEntriesReadArgs = z.object({
  entryIds: z
    .array(uuidSchema)
    .min(1)
    .max(entryStateService.MAX_ENTRY_STATE_BATCH)
    .describe("Array of entry IDs to mark"),
  read: z.boolean().describe("Mark as read (true) or unread (false)"),
});

const starEntriesArgs = z.object({
  entryId: uuidSchema.describe("Entry ID"),
  starred: z.boolean().describe("Star (true) or unstar (false)"),
});

const entryCount = entryCountInputSchema().shape;
const countEntriesArgs = entryCountInputSchema().extend({
  subscriptionId: entryCount.subscriptionId.describe(
    "Count a subscription's unread entries (a feed, a collection or Saved)"
  ),
  tagId: entryCount.tagId.describe("Count a tag's unread entries"),
  uncategorized: entryCount.uncategorized.describe(
    "Count unread entries in untagged subscriptions"
  ),
  type: entryCount.type.describe("Count unread saved articles"),
  starredOnly: entryCount.starredOnly.describe("Count unread starred entries"),
});

const saveCollectionIdsArg = saveCollectionIdsSchema.describe(
  "Optional collection IDs to also add the article to (see create_collection)"
);

const saveArticleArgs = z.object({
  url: savedArticleUrlSchema.describe("The URL to save"),
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
  refetch: z
    .boolean()
    .optional()
    .describe(
      "If the URL is already saved, fetch it again and update the article in place, " +
        "keeping its ID, starred state and collections (it is marked unread). Title, " +
        "author and summary come from the new fetch, so pass any overrides again. " +
        "Without this, an already-saved article is returned unchanged."
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      "With refetch, update even if the new content looks much shorter than the saved " +
        "copy (by default that refetch is rejected, since it usually means an error or " +
        "access-denied page)."
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

const subscriptionList = subscriptionListInputSchema().shape;
const listSubscriptionsArgs = subscriptionListInputSchema().extend({
  query: subscriptionList.query.describe("Case-insensitive title search (substring matching)"),
  tagId: subscriptionList.tagId.describe("Filter by tag ID"),
  uncategorized: subscriptionList.uncategorized.describe("Only show subscriptions with no tags"),
  unreadOnly: subscriptionList.unreadOnly.describe("Only show feeds with unread items"),
  // The saved subscription is never listed, so `saved` would match nothing.
  type: z
    .enum(["web", "email", "collection", "saved"])
    .optional()
    .describe("Only show this kind: web feeds, newsletters, collections, or Saved"),
  limit: subscriptionList.limit.describe(
    `Number of subscriptions per page (max ${subscriptionsService.MAX_SUBSCRIPTIONS_PAGE_SIZE})`
  ),
  cursor: subscriptionList.cursor.describe("Pagination cursor from previous response"),
});

const getSubscriptionArgs = z.object({
  subscriptionId: uuidSchema.describe("Subscription ID"),
});

const setSubscriptionTagsArgs = z.object({
  subscriptionId: uuidSchema.describe("Subscription ID (a feed or a collection)"),
  tagIds: subscriptionTagIdsSchema.describe(
    "The complete set of tag IDs it should have; an empty array removes all tags"
  ),
});

const createCollectionArgs = z.object({
  name: collectionNameSchema.describe("Collection name (unique per user ignoring case)"),
});

const collectionEntriesArgs = z.object({
  collectionId: uuidSchema.describe(
    "The collection's subscription ID (list_subscriptions shows collections with type 'collection')"
  ),
  entryIds: collectionEntryIdsSchema.describe("Entry IDs"),
});

const listTagsArgs = z.object({});

const createTagArgs = z.object({
  name: tagNameSchema.describe(
    `Tag name (max ${tagsService.TAG_NAME_MAX_LENGTH} characters, unique per user ignoring case)`
  ),
  color: tagColorSchema
    .optional()
    .describe("Optional hex color (e.g., #ff6b6b). Null to remove color."),
});

const updateTagArgs = z.object({
  tagId: uuidSchema.describe("Tag ID"),
  name: tagNameSchema
    .optional()
    .describe(
      `New tag name (max ${tagsService.TAG_NAME_MAX_LENGTH} characters, unique per user ignoring case)`
    ),
  color: tagColorSchema.optional().describe("New hex color (e.g., #ff6b6b). Null to remove color."),
});

const deleteTagArgs = z.object({
  tagId: uuidSchema.describe("Tag ID to delete"),
});

// ============================================================================
// Tool Definitions
// ============================================================================

/**
 * Returns every MCP tool, each wrapping a service function.
 *
 * The tool list is static (handlers take db/userId as parameters), so it is
 * built once per process — the stateless MCP HTTP route calls this on every
 * request, and rebuilding would re-run every z.toJSONSchema conversion.
 */
export function getTools(): Tool[] {
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
        const [user] = await db
          .select({ showSpam: users.showSpam })
          .from(users)
          .where(eq(users.id, userId));
        return entriesService.listEntries(db, {
          userId,
          ...params,
          showSpam: user?.showSpam ?? false,
        });
      },
    },

    {
      name: "get_entry",
      description:
        "Get a single entry with its content (original and cleaned HTML, plus `fullContent`: the article fetched from its URL when the subscription has full content enabled).",
      inputSchema: toInputSchema(getEntryArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(getEntryArgs, args);
        return entryReadsService.getEntry(db, userId, params.entryId);
      },
    },

    {
      name: "mark_entries_read",
      description: `Mark entries as read or unread (bulk operation, max ${entryStateService.MAX_ENTRY_STATE_BATCH}). Returns updated entries and unread counts.`,
      inputSchema: toInputSchema(markEntriesReadArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(markEntriesReadArgs, args);
        // markEntriesRead computes the counts and publishes entry_state_changed
        // for multi-tab/device sync itself, mirroring the tRPC mutation.
        const { entries, counts } = await entryStateService.markEntriesRead(
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
        const { entry } = await entryStateService.updateEntryStarred(
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
      description:
        "Get the unread count of one list: all entries by default, or at most one of subscriptionId, tagId, uncategorized, type and starredOnly.",
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
        "Save a URL for later reading. Fetches the page, extracts clean content using Readability, and stores it. Returns the saved article's metadata and excerpt (not its content; use get_entry for that), including when it was already saved (pass refetch=true to fetch an already-saved URL again and update it). Private Google Docs are supported when the user has linked their Google account and granted Google Docs access in the web app; otherwise a clear error explains how to authorize.",
      inputSchema: toInputSchema(saveArticleArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(saveArticleArgs, args);
        const article = await savedService.saveArticle(db, userId, {
          url: params.url,
          title: params.title,
          author: params.author,
          excerpt: params.summary,
          refetch: params.refetch,
          force: params.force,
          collectionIds: params.collectionIds,
          // Use the user's stored Google credentials for private Google Docs
          // when already linked/granted; otherwise throw a clear error telling
          // them to authorize Google Docs access in the web app (an MCP client
          // can't run the interactive consent flow).
          userAuth: "non-interactive",
        });
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
        const article = await savedService.uploadArticle(db, userId, {
          content: params.content,
          title: params.title,
          author: params.author,
          excerpt: params.summary,
          collectionIds: params.collectionIds,
        });
        return withoutContent(article);
      },
    },

    // ========================================================================
    // Subscriptions Tools
    // ========================================================================

    {
      name: "list_subscriptions",
      description:
        "List active subscriptions — feeds, newsletters, collections (type 'collection') and, once the user has saved an article, their Saved subscription (type 'saved', which can't be tagged, renamed or removed) — with optional filtering and pagination. Supports case-insensitive title search, tag, type and unread-only filtering, and cursor-based pagination.",
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
        await subscriptionUpdatesService.setSubscriptionTags(
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
        "add_to_collection and the subscriptionId for list_entries and set_subscription_tags. " +
        "If a collection with that name (ignoring case) already exists, returns it unchanged " +
        "with created: false.",
      inputSchema: toInputSchema(createCollectionArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(createCollectionArgs, args);
        const { subscription, created } = await collectionsService.createCollection(
          db,
          userId,
          params.name
        );
        return { ...subscription, created };
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
      description:
        "Create a tag for organizing subscriptions. If a tag with that name (ignoring case) already exists, returns it unchanged with created: false.",
      inputSchema: toInputSchema(createTagArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(createTagArgs, args);
        const { tag, created } = await tagsService.createTag(db, userId, {
          name: params.name,
          color: params.color,
        });
        return { ...tag, created };
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
