/**
 * Admin Router
 *
 * Handles admin operations: invite management, feed health monitoring, and user listing.
 * All endpoints require ALLOWLIST_SECRET Bearer token.
 */

import { z } from "zod";

import { createTRPCRouter, adminProcedure } from "../trpc";
import { booleanQueryParam } from "../validation";
import { retryFeed } from "@/server/services/feeds";
import { createInvite, listInvites, revokeInvite } from "@/server/services/invites";
import { listAdminFeeds } from "@/server/services/admin-feeds";
import { ADMIN_USER_SORTS, listAdminUsers } from "@/server/services/admin-users";
import { getAdminOverview } from "@/server/services/admin-stats";
import {
  getMaintenanceRaw,
  getAnnouncementRaw,
  getAnnouncement,
  setMaintenance,
  setAnnouncement,
} from "@/server/services/site-status";
import { ANNOUNCEMENT_LEVELS } from "@/lib/events/schemas";
import { publishSiteStatusEvent } from "@/server/redis/pubsub";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default page size */
const DEFAULT_LIMIT = 50;

/** Maximum page size */
const MAX_LIMIT = 100;

/** Shared pagination input schema; `cursor` is an opaque codec-encoded keyset tuple */
const paginationInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

// ============================================================================
// INVITE ENDPOINTS
// ============================================================================

const inviteEndpoints = {
  /**
   * Create a new invite.
   *
   * Generates a one-time use invite link that expires in 7 days.
   * Returns the full URL that can be shared with the user.
   */
  createInvite: adminProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/admin/invites",
        tags: ["Admin"],
        summary: "Create a new invite",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        invite: z.object({
          id: z.string(),
          token: z.string(),
          expiresAt: z.date(),
        }),
        inviteUrl: z.string(),
      })
    )
    .mutation(async ({ ctx }) => createInvite(ctx.db)),

  /**
   * List all invites with cursor-based pagination and optional search.
   *
   * Search filters by used-by user email (partial match, case-insensitive).
   * Ordered by createdAt DESC (newest first), using UUIDv7 id as cursor.
   */
  listInvites: adminProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/admin/invites",
        tags: ["Admin"],
        summary: "List all invites",
      },
    })
    .input(
      paginationInput
        .extend({
          search: z.string().optional(),
        })
        .optional()
    )
    .output(
      z.object({
        items: z.array(
          z.object({
            id: z.string(),
            token: z.string(),
            expiresAt: z.date(),
            createdAt: z.date(),
            status: z.enum(["pending", "used", "expired"]),
            usedAt: z.date().nullable(),
            usedByEmail: z.string().nullable(),
          })
        ),
        nextCursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) =>
      listInvites(ctx.db, {
        limit: input?.limit ?? DEFAULT_LIMIT,
        cursor: input?.cursor,
        search: input?.search,
      })
    ),

  /**
   * Revoke an unused invite.
   *
   * Deletes the invite so it can no longer be used.
   * Only pending (unused, non-expired) invites can be revoked.
   */
  revokeInvite: adminProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/admin/invites/{inviteId}",
        tags: ["Admin"],
        summary: "Revoke an invite",
      },
    })
    .input(
      z.object({
        inviteId: z.string().uuid(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await revokeInvite(ctx.db, input.inviteId);
      return { success: true };
    }),
} as const;

// ============================================================================
// FEED HEALTH ENDPOINTS
// ============================================================================

const feedHealthEndpoints = {
  /**
   * List ALL web feeds in the system (admin-level, not user-specific).
   *
   * Supports filtering by URL substring, user email subscription, and broken status.
   * Ordered by consecutiveFailures DESC, then title ASC.
   */
  listFeeds: adminProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/admin/feeds",
        tags: ["Admin"],
        summary: "List all feeds in the system",
      },
    })
    .input(
      paginationInput
        .extend({
          urlFilter: z.string().optional(),
          userEmail: z.string().optional(),
          brokenOnly: booleanQueryParam,
          hasSubscribers: booleanQueryParam,
        })
        .optional()
    )
    .output(
      z.object({
        items: z.array(
          z.object({
            feedId: z.string(),
            title: z.string().nullable(),
            url: z.string().nullable(),
            siteUrl: z.string().nullable(),
            consecutiveFailures: z.number(),
            lastError: z.string().nullable(),
            lastFetchedAt: z.date().nullable(),
            lastEntriesUpdatedAt: z.date().nullable(),
            nextFetchAt: z.date().nullable(),
            websubActive: z.boolean(),
            subscriberCount: z.number(),
            lastFetchEntryCount: z.number().nullable(),
            lastFetchSizeBytes: z.number().nullable(),
            totalEntryCount: z.number(),
            entriesPerWeek: z.number().nullable(),
          })
        ),
        nextCursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) =>
      listAdminFeeds(ctx.db, {
        limit: input?.limit ?? DEFAULT_LIMIT,
        cursor: input?.cursor,
        urlFilter: input?.urlFilter,
        userEmail: input?.userEmail,
        brokenOnly: input?.brokenOnly,
        hasSubscribers: input?.hasSubscribers,
      })
    ),

  /**
   * Admin retry for any feed (no subscription check).
   *
   * Resets consecutiveFailures to 0 and sets nextFetchAt to now.
   * Also updates the associated fetch_feed job to run immediately.
   */
  retryFeedFetch: adminProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/admin/feeds/{feedId}/retry",
        tags: ["Admin"],
        summary: "Retry fetching a feed",
      },
    })
    .input(
      z.object({
        feedId: z.string().uuid("Invalid feed ID"),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await retryFeed(ctx.db, input.feedId);

      return { success: true };
    }),
} as const;

// ============================================================================
// USER ENDPOINTS
// ============================================================================

const userEndpoints = {
  /**
   * List ALL users in the system.
   *
   * Supports search by email (partial match, case-insensitive) and a choice of
   * sort orders (see ADMIN_USER_SORTS). Includes computed fields: OAuth providers,
   * subscription count, entry count, and last activity.
   * Defaults to most-recent-activity first.
   */
  listUsers: adminProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/admin/users",
        tags: ["Admin"],
        summary: "List all users",
      },
    })
    .input(
      paginationInput
        .extend({
          search: z.string().optional(),
          sort: z.enum(ADMIN_USER_SORTS).default("activity"),
        })
        .optional()
    )
    .output(
      z.object({
        items: z.array(
          z.object({
            id: z.string(),
            email: z.string(),
            createdAt: z.date(),
            providers: z.array(z.string()),
            subscriptionCount: z.number(),
            entryCount: z.number(),
            lastActiveAt: z.date().nullable(),
            lastTokenUsedAt: z.date().nullable(),
          })
        ),
        nextCursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) =>
      listAdminUsers(ctx.db, {
        limit: input?.limit ?? DEFAULT_LIMIT,
        cursor: input?.cursor,
        search: input?.search,
        sort: input?.sort ?? "activity",
      })
    ),
} as const;

// ============================================================================
// OVERVIEW ENDPOINTS
// ============================================================================

const overviewEndpoints = {
  /**
   * Get system overview stats.
   *
   * Returns aggregate counts for users, feeds, entries, and active user metrics.
   */
  getOverview: adminProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/admin/overview",
        tags: ["Admin"],
        summary: "Get system overview statistics",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        totalUsers: z.number(),
        activeUsersLast7Days: z.number(),
        activeUsersLast30Days: z.number(),
        totalFeeds: z.number(),
        totalFeedsWithSubscribers: z.number(),
        brokenFeeds: z.number(),
        totalEntries: z.number(),
        totalSubscriptions: z.number(),
        pendingInvites: z.number(),
      })
    )
    .query(async ({ ctx }) => getAdminOverview(ctx.db)),
} as const;

// ============================================================================
// SITE STATUS ENDPOINTS (announcement banner + maintenance mode)
// ============================================================================

/** Max length for admin-entered banner / maintenance messages. */
const SITE_STATUS_MESSAGE_MAX = 1000;

const siteStatusEndpoints = {
  /**
   * Read the current announcement + maintenance configuration (raw stored
   * values, including disabled state) so the admin form can prefill.
   */
  getSiteStatus: adminProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/admin/site-status",
        tags: ["Admin"],
        summary: "Get announcement banner and maintenance mode status",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        maintenance: z.object({
          enabled: z.boolean(),
          message: z.string(),
        }),
        announcement: z.object({
          enabled: z.boolean(),
          message: z.string(),
          level: z.enum(ANNOUNCEMENT_LEVELS),
        }),
      })
    )
    .query(async () => {
      const [maintenance, announcement] = await Promise.all([
        getMaintenanceRaw(),
        getAnnouncementRaw(),
      ]);
      return { maintenance, announcement };
    }),

  /**
   * Set the site-wide announcement banner. `enabled=false` (or an empty
   * message) hides it. The message is what determines the banner id, so
   * changing the text re-shows the banner to users who dismissed the old one.
   */
  setAnnouncement: adminProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/admin/site-status/announcement",
        tags: ["Admin"],
        summary: "Set the announcement banner",
      },
    })
    .input(
      z.object({
        enabled: z.boolean(),
        message: z.string().max(SITE_STATUS_MESSAGE_MAX),
        level: z.enum(ANNOUNCEMENT_LEVELS),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      await setAnnouncement(input);
      // Broadcast the change so open clients update the banner live (no reload).
      // getAnnouncement() reflects the just-written value (setAnnouncement busts
      // the cache) and resolves the message-derived id, or null when disabled.
      // A failed broadcast doesn't fail the save: clients pick it up on their
      // next page load.
      await publishSiteStatusEvent({
        type: "announcement_changed",
        announcement: await getAnnouncement(),
      });
      return { success: true };
    }),

  /**
   * Enable or disable maintenance mode. When enabled, the custom server serves
   * a maintenance page for everything except the demo + admin panel + health
   * check, and the worker and Discord bot pause. Intended for DB migrations.
   */
  setMaintenance: adminProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/admin/site-status/maintenance",
        tags: ["Admin"],
        summary: "Enable or disable maintenance mode",
      },
    })
    .input(
      z.object({
        enabled: z.boolean(),
        message: z.string().max(SITE_STATUS_MESSAGE_MAX).optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      await setMaintenance(input);
      return { success: true };
    }),
} as const;

// ============================================================================
// ROUTER
// ============================================================================

export const adminRouter = createTRPCRouter({
  // Overview
  ...overviewEndpoints,
  // Invites
  ...inviteEndpoints,
  // Feed health
  ...feedHealthEndpoints,
  // Users
  ...userEndpoints,
  // Site status (announcement banner + maintenance mode)
  ...siteStatusEndpoints,
});
