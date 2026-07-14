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
import * as entriesService from "@/server/services/entries";
import * as subscriptionsService from "@/server/services/subscriptions";
import * as savedService from "@/server/services/saved";
import * as tagsService from "@/server/services/tags";

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
 * Convert service-layer errors into structured MCP errors so clients receive
 * a parseable InvalidParams instead of an opaque internal error. Services
 * throw TRPCErrors (their native error type across all transports); bad IDs
 * and invalid cursors surface as BAD_REQUEST/NOT_FOUND.
 */
export function toMcpError(error: unknown): unknown {
  if (error instanceof McpError) {
    return error;
  }
  if (error instanceof TRPCError) {
    const code =
      error.code === "BAD_REQUEST" || error.code === "NOT_FOUND"
        ? ErrorCode.InvalidParams
        : ErrorCode.InternalError;
    return new McpError(code, error.message);
  }
  return error;
}

/**
 * Strips the Google Reader-internal `greaderItemId` from an entry before it
 * reaches an MCP response. The field is a bigint, which the transports'
 * `JSON.stringify` can't serialize (it throws), and it's meaningless to MCP
 * clients — only the Google Reader compat layer consumes it. The tRPC/REST
 * surfaces strip it via their Zod output schemas; MCP serializes service
 * results directly, so it must be dropped here.
 */
function stripGreaderItemId<T extends { greaderItemId: bigint }>(
  entry: T
): Omit<T, "greaderItemId"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { greaderItemId, ...rest } = entry;
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
    .describe(
      "Optional full-text search query (searches both title and content, results ranked by relevance)"
    ),
  subscriptionId: uuidSchema.optional().describe("Filter by subscription ID"),
  tagId: uuidSchema.optional().describe("Filter by tag ID"),
  uncategorized: z.boolean().optional().describe("Show only uncategorized entries"),
  type: z.enum(["web", "email", "saved"]).optional().describe("Filter by entry type"),
  unreadOnly: z.boolean().optional().describe("Show only unread entries"),
  readOnly: z.boolean().optional().describe("Show only read entries"),
  starredOnly: z.boolean().optional().describe("Show only starred entries"),
  unstarredOnly: z.boolean().optional().describe("Show only unstarred entries"),
  sortOrder: z
    .enum(["newest", "oldest"])
    .optional()
    .describe("Sort order (default: newest). Ignored when query is provided."),
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
  subscriptionId: uuidSchema.optional().describe("Filter by subscription ID"),
  tagId: uuidSchema.optional().describe("Filter by tag ID"),
  uncategorized: z.boolean().optional().describe("Count only uncategorized entries"),
  type: z.enum(["web", "email", "saved"]).optional().describe("Filter by entry type"),
  unreadOnly: z.boolean().optional().describe("Count only unread entries"),
  readOnly: z.boolean().optional().describe("Count only read entries"),
  starredOnly: z.boolean().optional().describe("Count only starred entries"),
  unstarredOnly: z.boolean().optional().describe("Count only unstarred entries"),
});

const saveArticleArgs = z.object({
  url: z.url().describe("The URL to save"),
  title: z.string().optional().describe("Optional title override (useful if page title is poor)"),
});

const deleteSavedArticleArgs = z.object({
  articleId: uuidSchema.describe("The saved article ID to delete"),
});

const uploadArticleArgs = z.object({
  content: z
    .string()
    .min(1)
    .describe("Article content in Markdown format (GitHub Flavored Markdown supported)"),
  title: z.string().min(1).describe("Article title"),
});

const listSubscriptionsArgs = z.object({
  query: z.string().optional().describe("Case-insensitive title search (substring matching)"),
  tagId: uuidSchema.optional().describe("Filter by tag ID"),
  unreadOnly: z.boolean().optional().describe("Only show feeds with unread items"),
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
        "List feed entries with filters and pagination. Optionally perform full-text search with the query parameter (searches both title and content, results ranked by relevance). Without query, returns entries sorted by time. Returns summaries (title, snippet) without full content.",
      inputSchema: toInputSchema(listEntriesArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(listEntriesArgs, args);
        const result = await entriesService.listEntries(db, {
          userId,
          ...params,
          showSpam: false, // Default to hiding spam for MCP
        });
        return { ...result, items: result.items.map(stripGreaderItemId) };
      },
    },

    {
      name: "get_entry",
      description: "Get a single entry with full content (original and cleaned HTML).",
      inputSchema: toInputSchema(getEntryArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(getEntryArgs, args);
        const entry = await entriesService.getEntry(db, userId, params.entryId);
        return entry ? stripGreaderItemId(entry) : entry;
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
      description:
        "Star or unstar entries (bulk operation). Starred entries remain visible after unsubscribing.",
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
        "Save a URL for later reading. Fetches the page, extracts clean content using Readability, and stores it. Returns the saved article if already saved. Private Google Docs are supported when the user has linked their Google account and granted Google Docs access in the web app; otherwise a clear error explains how to authorize.",
      inputSchema: toInputSchema(saveArticleArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(saveArticleArgs, args);
        return savedService.saveArticle(db, userId, {
          url: params.url,
          title: params.title,
          // Use the user's stored Google credentials for private Google Docs
          // when already linked/granted; otherwise throw a clear error telling
          // them to authorize Google Docs access in the web app (an MCP client
          // can't run the interactive consent flow).
          googleDocsAuth: "non-interactive",
        });
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
        "Upload an article with Markdown content directly, without a URL. Useful for saving content you've written or collected.",
      inputSchema: toInputSchema(uploadArticleArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(uploadArticleArgs, args);
        return savedService.uploadArticle(db, userId, {
          content: params.content,
          title: params.title,
        });
      },
    },

    // ========================================================================
    // Subscriptions Tools
    // ========================================================================

    {
      name: "list_subscriptions",
      description:
        "List active feed subscriptions with optional filtering and pagination. Supports case-insensitive title search, tag filtering, unread-only filtering, and cursor-based pagination.",
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
