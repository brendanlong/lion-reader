/**
 * MCP Tool Definitions
 *
 * Defines the tools (functions) available to AI assistants via MCP.
 * Each tool wraps service layer functions with MCP-specific interfaces.
 */

import type { db as dbType } from "@/server/db";
import * as entriesService from "@/server/services/entries";
import * as subscriptionsService from "@/server/services/subscriptions";

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
        "List feed entries with filters and pagination. Returns summaries (title, snippet) without full content.",
      inputSchema: {
        type: "object",
        properties: {
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
            description: "Sort order (default: newest)",
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
      name: "search_entries",
      description:
        "Search feed entries by title and/or content using full-text search. Results ranked by relevance.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          searchIn: {
            type: "string",
            enum: ["title", "content", "both"],
            description: "Where to search (default: both)",
          },
          subscriptionId: { type: "string", description: "Filter by subscription ID" },
          tagId: { type: "string", description: "Filter by tag ID" },
          unreadOnly: { type: "boolean", description: "Show only unread entries" },
          starredOnly: { type: "boolean", description: "Show only starred entries" },
          limit: { type: "number", description: "Number of entries per page (max 100)" },
          cursor: { type: "string", description: "Pagination cursor from previous response" },
        },
        required: ["query"],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (db, args: any) => {
        const { userId, query, ...params } = args;
        return entriesService.searchEntries(db, {
          userId,
          query,
          ...params,
          showSpam: false,
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
    // Subscriptions Tools
    // ========================================================================

    {
      name: "list_subscriptions",
      description: "List all active feed subscriptions with unread counts and tags.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (db, args: any) => {
        const subscriptions = await subscriptionsService.listSubscriptions(db, args.userId);
        return { subscriptions };
      },
    },

    {
      name: "search_subscriptions",
      description:
        "Search subscriptions by feed title (custom or original). Results ranked by relevance.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (db, args: any) => {
        const subscriptions = await subscriptionsService.searchSubscriptions(
          db,
          args.userId,
          args.query
        );
        return { subscriptions };
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
