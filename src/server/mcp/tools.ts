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
  collectionPositionsSchema,
  entryCountInputSchema,
  entryListInputSchema,
  entryScoresSchema,
  savedArticleUrlSchema,
  saveCollectionIdsSchema,
  subscriptionListInputSchema,
  subscriptionTagIdsSchema,
  tagColorSchema,
  tagNameSchema,
  uploadIdempotencyKeySchema,
  uuidSchema,
} from "@/server/trpc/validation";
import { getAppErrorCode } from "@/server/errors";
import * as entriesService from "@/server/services/entries";
import * as entryReadsService from "@/server/services/entry-reads";
import * as entryScoresService from "@/server/services/entry-scores";
import * as entryStateService from "@/server/services/entry-state";
import * as subscriptionUpdatesService from "@/server/services/subscription-updates";
import * as subscriptionsService from "@/server/services/subscriptions";
import * as savedService from "@/server/services/saved";
import * as tagsService from "@/server/services/tags";
import * as collectionsService from "@/server/services/collections";
import { MAX_COLLECTION_ENTRIES } from "@/lib/collections";

// ============================================================================
// Types
// ============================================================================

/**
 * MCP tool annotations with every hint required: the spec's defaults for an
 * omitted hint (destructive, not idempotent, open world) are wrong for most of
 * our tools, and clients use them to decide what needs the user's confirmation.
 */
type ToolHints = { title: string; openWorldHint: boolean } & (
  | { readOnlyHint: true }
  | { readOnlyHint: false; destructiveHint: boolean; idempotentHint: boolean }
);

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations: ToolHints;
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
  sortBy: entryList.sortBy.describe(
    "What to sort by. Default: a collection whose articles have positions by position, " +
      "anything else by date. published (date), readChanged (when last marked " +
      "read or unread; only entries ever marked, across all subscriptions: not with " +
      "subscriptionId, tagId, uncategorized or type saved), score (set_entry_scores) or position (a " +
      "collection's order, set_collection_positions; needs subscriptionId). Entries without " +
      "a score or position come after those with one, newest first. The first page's " +
      "`sortable` says whether the list has any scores or positions."
  ),
  sortOrder: entryList.sortOrder.describe(
    "Direction of sortBy: newest/oldest for dates, highest/lowest for score, first/last for " +
      "position (default: the first of each)"
  ),
  limit: entryList.limit.describe(
    `Number of entries per page (max ${entriesService.MAX_ENTRIES_PAGE_SIZE})`
  ),
  cursor: entryList.cursor.describe("Pagination cursor from previous response"),
});

const setEntryScoresArgs = z.object({
  scores: entryScoresSchema.describe("The entries to score"),
});

const collectionPositionsArgs = z
  .object({
    collectionId: uuidSchema.describe("The collection's subscription ID"),
    entryIds: z
      .array(uuidSchema)
      .min(1)
      .max(MAX_COLLECTION_ENTRIES)
      .optional()
      .describe("Entry IDs in order: they get positions 1, 2, 3, …"),
    positions: collectionPositionsSchema
      .optional()
      .describe("Entries and their positions, to move a few without renumbering the rest"),
  })
  .refine((args) => (args.entryIds === undefined) !== (args.positions === undefined), {
    message: "Pass exactly one of entryIds and positions",
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
  idempotencyKey: uploadIdempotencyKeySchema.describe(
    "Optional key (letters, digits, _ and -; up to 128) unique to this article. Pass the " +
      "same key when retrying a call that timed out or failed: if the first attempt saved " +
      "the article, it's returned instead of saving a duplicate."
  ),
  collectionIds: saveCollectionIdsArg,
});

const subscriptionList = subscriptionListInputSchema().shape;
const listSubscriptionsArgs = subscriptionListInputSchema().extend({
  query: subscriptionList.query.describe("Case-insensitive title search (substring matching)"),
  tagId: subscriptionList.tagId.describe("Filter by tag ID"),
  uncategorized: subscriptionList.uncategorized.describe("Only show subscriptions with no tags"),
  unreadOnly: subscriptionList.unreadOnly.describe("Only show feeds with unread items"),
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

const deleteCollectionArgs = z.object({
  collectionId: uuidSchema.describe("The collection's subscription ID"),
  deleteSavedArticles: z
    .boolean()
    .optional()
    .describe(
      "Also permanently delete the saved articles in this collection that are in no other " +
        "collection. Off by default: the articles stay in Saved."
    ),
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

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
const write = (hints: { destructiveHint: boolean; idempotentHint: boolean }) =>
  ({ readOnlyHint: false, openWorldHint: false, ...hints }) as const;

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
        "List the user's entries (feed items, newsletter issues and saved articles), newest first " +
        "by default. Use this to browse or search: filter by subscription, tag, type, read or " +
        "starred state, sort by date, score or a collection's position (see sortBy), or pass " +
        "`query` for relevance-ranked full-text search. Returns `items` (id, title, summary, url, " +
        "read/starred state, score, subscription IDs; no body) and `nextCursor` when there are " +
        "more: pass it as `cursor` for the next page. Use get_entry for an entry's content, and " +
        "count_entries when you only need an unread count.",
      annotations: { title: "List entries", ...readOnly },
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
        "Get one entry with its content: the original and cleaned HTML, plus `fullContent` (the " +
        "article fetched from its URL) when its subscription has full content enabled. Use this " +
        "to read an entry whose ID you got from list_entries, save_article or upload_article. " +
        "Doesn't mark it read (use mark_entries_read). Fails with a not-found error if the entry " +
        "doesn't exist or isn't visible to the user.",
      annotations: { title: "Get entry", ...readOnly },
      inputSchema: toInputSchema(getEntryArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(getEntryArgs, args);
        return entryReadsService.getEntry(db, userId, params.entryId);
      },
    },

    {
      name: "mark_entries_read",
      description:
        `Mark up to ${entryStateService.MAX_ENTRY_STATE_BATCH} entries as read or unread in one ` +
        "call. Reversible (call again with the opposite `read`) and idempotent. Returns the " +
        "entries' new state (IDs the user can't see are left out) and, when anything changed, the " +
        "affected unread counts. To star an entry use star_entries.",
      annotations: {
        title: "Mark entries read or unread",
        ...write({ destructiveHint: false, idempotentHint: true }),
      },
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
      // Single-entry despite the plural: the tool name is part of the
      // published MCP surface, so it stays as-is.
      description:
        "Star or unstar one entry (call once per entry). Starred entries stay visible in the " +
        "Starred list even after unsubscribing from their feed; unstarring one from a feed the " +
        "user has left removes it from view. Idempotent. Fails with a not-found error if the user " +
        "has no such entry. Returns the entry's new state. To group entries under a name instead, " +
        "use a collection (add_to_collection); to rank them, set_entry_scores.",
      annotations: {
        title: "Star or unstar entry",
        ...write({ destructiveHint: false, idempotentHint: true }),
      },
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
      name: "set_entry_scores",
      description:
        `Set or clear (null) numeric scores on up to ${entryScoresService.MAX_ENTRY_SCORE_BATCH} ` +
        "entries, to prioritize the user's reading: lists sorted by score (list_entries sortBy: " +
        "score) show higher scores first, then unscored entries. A score is the user's, so it " +
        "applies in every list the entry is in. Overwrites any previous score; idempotent. " +
        "Returns the entries whose score changed and the IDs not found (nothing is set for " +
        "those). To order a single collection by hand, use set_collection_positions instead.",
      annotations: {
        title: "Set entry scores",
        ...write({ destructiveHint: false, idempotentHint: true }),
      },
      inputSchema: toInputSchema(setEntryScoresArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(setEntryScoresArgs, args);
        return entryScoresService.setEntryScores(db, userId, params.scores);
      },
    },

    {
      name: "count_entries",
      description:
        "Get the unread count of one list as { unread, asOf }: all entries by default, or pass at " +
        "most one of subscriptionId, tagId, uncategorized, type and starredOnly (more is an " +
        "invalid-arguments error). An ID that isn't one of the user's subscriptions or tags " +
        "counts 0. Cheaper than paging through list_entries when you only need the number; " +
        "list_tags and list_subscriptions include unread counts per tag and subscription.",
      annotations: { title: "Count unread entries", ...readOnly },
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
        "Save a web page by URL to the user's Saved list: fetches it, extracts the article with " +
        "Readability and stores it. For content you already have, use upload_article instead. A " +
        "URL that's already saved is returned unchanged unless you pass refetch, which replaces " +
        "the stored copy. Returns the article's id, metadata, an excerpt and `outcome` (created, " +
        "updated or existing), not the content (use get_entry for that). Errors carry an app code " +
        "in their data, e.g. when the site rate limits us or the user's fetch quota is used up. " +
        "Private Google Docs work once the user has granted Google Docs access in the web app; " +
        "otherwise the error says how.",
      annotations: {
        title: "Save article from URL",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
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
      description:
        "Permanently delete an article from the user's Saved list (saved by URL or uploaded), and " +
        "from every collection. Can't be undone. Feed entries can't be deleted: mark them read, " +
        "or take them out of a collection with remove_from_collection. Returns { deleted: false } " +
        "if the ID isn't one of the user's saved articles (e.g. already deleted).",
      annotations: {
        title: "Delete saved article",
        ...write({ destructiveHint: true, idempotentHint: true }),
      },
      inputSchema: toInputSchema(deleteSavedArticleArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(deleteSavedArticleArgs, args);
        const counts = await savedService.deleteSavedArticle(db, userId, params.articleId);
        return { deleted: counts !== null };
      },
    },

    {
      name: "upload_article",
      description:
        "Save an article from Markdown you provide (e.g. something you wrote, summarized or " +
        "collected), with no URL to fetch. For a web page, use save_article instead. Each call " +
        "creates a new article unless it repeats an earlier call's idempotencyKey. Returns the " +
        "article's id and metadata with an excerpt, not the content (use get_entry for that).",
      annotations: {
        title: "Upload Markdown article",
        ...write({ destructiveHint: false, idempotentHint: false }),
      },
      inputSchema: toInputSchema(uploadArticleArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(uploadArticleArgs, args);
        const article = await savedService.uploadArticle(db, userId, {
          content: params.content,
          title: params.title,
          author: params.author,
          excerpt: params.summary,
          idempotencyKey: params.idempotencyKey,
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
        "List the user's active subscriptions: web feeds, newsletters, collections and (once " +
        "they've saved an article) their Saved list, which can't be tagged, renamed or removed. " +
        "Each has its id, title, type, tags and unread count. Use this to find the subscriptionId " +
        "or collectionId other tools take. Returns `items` and `nextCursor` when there are more: " +
        "pass it as `cursor` for the next page. With an ID already in hand, use get_subscription.",
      annotations: { title: "List subscriptions", ...readOnly },
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
      description:
        "Get one subscription by ID (from list_subscriptions or an entry's subscription IDs), " +
        "including its type, unread count and tags. Fails with a not-found error if the user has " +
        "no active subscription with that ID.",
      annotations: { title: "Get subscription", ...readOnly },
      inputSchema: toInputSchema(getSubscriptionArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(getSubscriptionArgs, args);
        return subscriptionsService.getSubscription(db, userId, params.subscriptionId);
      },
    },

    {
      name: "set_subscription_tags",
      description:
        "Replace the complete set of tags on a subscription (a feed, newsletter or collection; " +
        "not Saved). To add one tag, pass the subscription's current tags (from get_subscription) " +
        "plus the new one. Tags group subscriptions in the sidebar; create them with create_tag " +
        "and find their IDs with list_tags. Idempotent. Fails with a not-found error if the " +
        "subscription isn't the user's, and with an invalid-arguments error, changing nothing, if " +
        "any tag isn't.",
      annotations: {
        title: "Set subscription tags",
        ...write({ destructiveHint: true, idempotentHint: true }),
      },
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
        "Create a collection: a named list of articles the user fills by hand (with " +
        "add_to_collection), shown and tagged like a feed. For grouping whole feeds, use a tag " +
        "(create_tag) instead. Returns it as a subscription; its id is the collectionId for the " +
        "collection tools and the subscriptionId for list_entries and set_subscription_tags. If a " +
        "collection with that name (ignoring case) already exists, returns it unchanged with " +
        "created: false. Fails if the user is at their plan's subscription limit.",
      annotations: {
        title: "Create collection",
        ...write({ destructiveHint: false, idempotentHint: true }),
      },
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
      name: "delete_collection",
      description:
        "Delete a collection. Can't be undone. Its articles stay in their feeds and in Saved " +
        "unless deleteSavedArticles is set. To take only some articles out, use " +
        "remove_from_collection instead. Fails with a not-found error if the user has no such " +
        "collection (e.g. already deleted).",
      annotations: {
        title: "Delete collection",
        ...write({ destructiveHint: true, idempotentHint: true }),
      },
      inputSchema: toInputSchema(deleteCollectionArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(deleteCollectionArgs, args);
        await collectionsService.deleteCollection(db, userId, params.collectionId, {
          deleteSavedArticles: params.deleteSavedArticles,
        });
        return { success: true };
      },
    },

    {
      name: "add_to_collection",
      description:
        "Add articles to a collection (find its ID with list_subscriptions, or make one with " +
        "create_collection). Any article the user can see works, feed entry or saved article; it " +
        "stays in its own feed too, sharing read and starred state. A collection holds at most " +
        `${MAX_COLLECTION_ENTRIES} articles. Returns the IDs newly added; IDs already present or ` +
        "not visible are skipped. Fails with a not-found error if the collection isn't the " +
        "user's. To order the collection, use set_collection_positions.",
      annotations: {
        title: "Add to collection",
        ...write({ destructiveHint: false, idempotentHint: true }),
      },
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
        "Remove articles from a collection without deleting them: they stay in their feeds and in " +
        "Saved (to delete a saved article, use delete_saved_article; to delete the whole " +
        "collection, delete_collection). Their positions in the collection are lost. Returns the " +
        "IDs actually removed; IDs not in the collection are skipped. Fails with a not-found " +
        "error if the collection isn't the user's.",
      annotations: {
        title: "Remove from collection",
        ...write({ destructiveHint: true, idempotentHint: true }),
      },
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

    {
      name: "set_collection_positions",
      description:
        "Set the order of articles in a collection (e.g. a book's chapters): a list sorted by " +
        "position (list_entries with the collection's subscriptionId and sortBy: position) shows " +
        "lower positions first, then articles without one. Pass exactly one of entryIds or " +
        "positions; articles you don't name keep their positions, so clear stale ones with null. " +
        "Articles must already be in the collection (add_to_collection). Returns the IDs whose " +
        "position changed and those not in the collection. Fails with a not-found error if the " +
        "collection isn't the user's.",
      annotations: {
        title: "Order collection",
        ...write({ destructiveHint: false, idempotentHint: true }),
      },
      inputSchema: toInputSchema(collectionPositionsArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(collectionPositionsArgs, args);
        return collectionsService.setCollectionPositions(
          db,
          userId,
          params.collectionId,
          params.positions ??
            (params.entryIds ?? []).map((entryId, i) => ({ entryId, position: i + 1 }))
        );
      },
    },

    // ========================================================================
    // Tags Tools
    // ========================================================================

    {
      name: "list_tags",
      description:
        "List all the user's tags as `items` (id, name, color, feedCount: subscriptions tagged, " +
        "unreadCount), plus `uncategorized` (feedCount and unreadCount of subscriptions with no " +
        "tag). Use this to find tag IDs for set_subscription_tags, list_entries, count_entries " +
        "and list_subscriptions, or before create_tag to see what exists.",
      annotations: { title: "List tags", ...readOnly },
      inputSchema: toInputSchema(listTagsArgs),
      handler: async (db, userId, args) => {
        parseArgs(listTagsArgs, args);
        return tagsService.listTags(db, userId);
      },
    },

    {
      name: "create_tag",
      description:
        "Create a tag for grouping subscriptions (apply it with set_subscription_tags). If a tag " +
        "with that name (ignoring case) already exists, returns it unchanged with created: false; " +
        "to rename or recolor a tag, use update_tag. Returns the tag and `created`.",
      annotations: {
        title: "Create tag",
        ...write({ destructiveHint: false, idempotentHint: true }),
      },
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
      description:
        "Rename or recolor one of the user's tags (find its ID with list_tags); only the fields " +
        "you pass change, and the tag keeps its subscriptions. Fails with a not-found error if " +
        "the tag isn't the user's, or with a name-taken error if another of their tags has the " +
        "new name (ignoring case). Returns the updated tag.",
      annotations: {
        title: "Update tag",
        ...write({ destructiveHint: false, idempotentHint: true }),
      },
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
        "Delete a tag and remove it from every subscription; the subscriptions and their entries " +
        "are kept (any left with no tag become Uncategorized). Can't be undone: recreating the " +
        "tag doesn't restore its subscriptions. To rename it, use update_tag. Fails with a " +
        "not-found error if the tag isn't the user's (e.g. already deleted).",
      annotations: {
        title: "Delete tag",
        ...write({ destructiveHint: true, idempotentHint: true }),
      },
      inputSchema: toInputSchema(deleteTagArgs),
      handler: async (db, userId, args) => {
        const params = parseArgs(deleteTagArgs, args);
        await tagsService.deleteTag(db, userId, params.tagId);
        return { success: true };
      },
    },
  ];
}
