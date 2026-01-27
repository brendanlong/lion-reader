/**
 * MCP Tool Definitions
 *
 * Defines the tools (functions) available to AI assistants via MCP.
 * Each tool wraps service layer functions with MCP-specific interfaces.
 */

import type { db as dbType } from "@/server/db";
import * as entriesService from "@/server/services/entries";
import * as subscriptionsService from "@/server/services/subscriptions";
import * as savedService from "@/server/services/saved";

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (db: typeof dbType, args: any) => Promise<unknown>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

/**
 * Registers all available MCP tools.
 * Each tool wraps a service function with MCP-compatible interface.
 */
export function registerTools(): Tool[] {
  return [
    // ========================================================================
    // Entries Tools
    // ========================================================================

    {
      name: "list_entries",
      description:
        "List feed entries with filters and pagination. Optionally perform full-text search with the query parameter (searches both title and content, results ranked by relevance). Without query, returns entries sorted by time. Returns summaries (title, snippet) without full content.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Optional full-text search query (searches both title and content, results ranked by relevance)",
          },
          subscriptionId: { type: "string", description: "Filter by subscription ID" },
          tagId: { type: "string", description: "Filter by tag ID" },
          uncategorized: { type: "boolean", description: "Show only uncategorized entries" },
          type: {
            type: "string",
            enum: ["web", "email", "saved"],
            description: "Filter by entry type",
          },
          unreadOnly: { type: "boolean", description: "Show only unread entries" },
          starredOnly: { type: "boolean", description: "Show only starred entries" },
          sortOrder: {
            type: "string",
            enum: ["newest", "oldest"],
            description: "Sort order (default: newest). Ignored when query is provided.",
          },
          limit: { type: "number", description: "Number of entries per page (max 100)" },
          cursor: { type: "string", description: "Pagination cursor from previous response" },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (db, args: any) => {
        const { userId, ...params } = args;
        return entriesService.listEntries(db, {
          userId,
          ...params,
          showSpam: false, // Default to hiding spam for MCP
        });
      },
    },

    {
      name: "get_entry",
      description: "Get a single entry with full content (original and cleaned HTML).",
      inputSchema: {
        type: "object",
        properties: {
          entryId: { type: "string", description: "Entry ID" },
        },
        required: ["entryId"],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (db, args: any) => {
        return entriesService.getEntry(db, args.userId, args.entryId);
      },
    },

    {
      name: "mark_entries_read",
      description:
        "Mark entries as read or unread (bulk operation, max 1000). Returns updated entries and unread counts.",
      inputSchema: {
        type: "object",
        properties: {
          entryIds: {
            type: "array",
            items: { type: "string" },
            description: "Array of entry IDs to mark",
          },
          read: { type: "boolean", description: "Mark as read (true) or unread (false)" },
        },
        required: ["entryIds", "read"],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (db, args: any) => {
        return entriesService.markEntriesRead(db, args.userId, args.entryIds, args.read);
      },
    },

    {
      name: "star_entries",
      description:
        "Star or unstar entries (bulk operation). Starred entries remain visible after unsubscribing.",
      inputSchema: {
        type: "object",
        properties: {
          entryId: { type: "string", description: "Entry ID" },
          starred: { type: "boolean", description: "Star (true) or unstar (false)" },
        },
        required: ["entryId", "starred"],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (db, args: any) => {
        return entriesService.updateEntryStarred(db, args.userId, args.entryId, args.starred);
      },
    },

    {
      name: "count_entries",
      description: "Get count of entries with filters. Returns total and unread counts.",
      inputSchema: {
        type: "object",
        properties: {
          subscriptionId: { type: "string", description: "Filter by subscription ID" },
          tagId: { type: "string", description: "Filter by tag ID" },
          uncategorized: { type: "boolean", description: "Count only uncategorized entries" },
          type: {
            type: "string",
            enum: ["web", "email", "saved"],
            description: "Filter by entry type",
          },
          unreadOnly: { type: "boolean", description: "Count only unread entries" },
          starredOnly: { type: "boolean", description: "Count only starred entries" },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (db, args: any) => {
        const { userId, ...params } = args;
        return entriesService.countEntries(db, userId, {
          ...params,
          showSpam: false,
        });
      },
    },

    // ========================================================================
    // Saved Articles Tools
    // ========================================================================

    {
      name: "save_article",
      description:
        "Save a URL for later reading. Fetches the page, extracts clean content using Readability, and stores it. Returns the saved article if already saved.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to save" },
          title: {
            type: "string",
            description: "Optional title override (useful if page title is poor)",
          },
        },
        required: ["url"],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (db, args: any) => {
        return savedService.saveArticle(db, args.userId, {
          url: args.url,
          title: args.title,
        });
      },
    },

    {
      name: "delete_saved_article",
      description: "Delete a saved article. Returns success status.",
      inputSchema: {
        type: "object",
        properties: {
          articleId: { type: "string", description: "The saved article ID to delete" },
        },
        required: ["articleId"],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (db, args: any) => {
        const deleted = await savedService.deleteSavedArticle(db, args.userId, args.articleId);
        return { deleted };
      },
    },

    {
      name: "upload_article",
      description:
        "Upload an article with Markdown content directly, without a URL. Useful for saving content you've written or collected.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Article content in Markdown format (GitHub Flavored Markdown supported)",
          },
          title: {
            type: "string",
            description: "Article title",
          },
        },
        required: ["content", "title"],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (db, args: any) => {
        return savedService.uploadArticle(db, args.userId, {
          content: args.content,
          title: args.title,
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
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Case-insensitive title search (substring matching)",
          },
          tagId: { type: "string", description: "Filter by tag ID" },
          unreadOnly: { type: "boolean", description: "Only show feeds with unread items" },
          limit: { type: "number", description: "Number of subscriptions per page (max 100)" },
          cursor: { type: "string", description: "Pagination cursor from previous response" },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (db, args: any) => {
        const { userId, ...params } = args;
        return subscriptionsService.listSubscriptions(db, {
          userId,
          ...params,
        });
      },
    },

    {
      name: "get_subscription",
      description: "Get details for a single subscription including unread count and tags.",
      inputSchema: {
        type: "object",
        properties: {
          subscriptionId: { type: "string", description: "Subscription ID" },
        },
        required: ["subscriptionId"],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (db, args: any) => {
        return subscriptionsService.getSubscription(db, args.userId, args.subscriptionId);
      },
    },
  ];
}
