/**
 * Admin Router
 *
 * Handles admin operations: invite management, feed health monitoring, and user listing.
 * All endpoints require ALLOWLIST_SECRET Bearer token.
 */

import { z } from "zod";
import { eq, and, isNull, sql, desc, asc, lt, gt, ilike, count, max } from "drizzle-orm";
import crypto from "crypto";

import { createTRPCRouter, adminProcedure } from "../trpc";
import {
  feeds,
  entries,
  subscriptions,
  users,
  invites,
  jobs,
  oauthAccounts,
  oauthAccessTokens,
  apiTokens,
  userEntries,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  getMaintenanceRaw,
  getAnnouncementRaw,
  getAnnouncement,
  setMaintenance,
  setAnnouncement,
  ANNOUNCEMENT_LEVELS,
} from "@/server/services/site-status";
import { publishAnnouncementChanged } from "@/server/redis/pubsub";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Invite validity duration in days */
const INVITE_VALIDITY_DAYS = 7;

/** Default page size */
const DEFAULT_LIMIT = 50;

/** Maximum page size */
const MAX_LIMIT = 100;

// ============================================================================
// HELPERS
// ============================================================================

/** Generate a random invite token (URL-safe base64) */
function generateInviteToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Get the app URL for generating invite links */
function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/** Shared pagination input schema */
const paginationInput = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

/**
 * Sort options for the admin user list. Each sorts by a durable, indexable
 * column on the users row so keyset (cursor) pagination stays correct:
 * - `activity`: most recent activity first (last_active_at DESC NULLS LAST)
 * - `created`:  newest accounts first (UUIDv7 id DESC)
 * - `oldest`:   oldest accounts first (id ASC)
 * - `email`:    email A→Z
 */
const USER_SORT = z.enum(["activity", "created", "oldest", "email"]);
type UserSort = z.infer<typeof USER_SORT>;

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
    .mutation(async ({ ctx }) => {
      const id = generateUuidv7();
      const token = generateInviteToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + INVITE_VALIDITY_DAYS * 24 * 60 * 60 * 1000);

      await ctx.db.insert(invites).values({
        id,
        token,
        expiresAt,
        createdAt: now,
      });

      const appUrl = getAppUrl();
      const inviteUrl = `${appUrl}/register?invite=${token}`;

      return {
        invite: {
          id,
          token,
          expiresAt,
        },
        inviteUrl,
      };
    }),

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
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const limit = input?.limit ?? DEFAULT_LIMIT;
      const cursor = input?.cursor;
      const search = input?.search;

      const conditions = [];

      // Cursor-based pagination: id < cursor (since we order by id DESC)
      if (cursor) {
        conditions.push(lt(invites.id, cursor));
      }

      // Search by used-by user email
      if (search) {
        conditions.push(ilike(users.email, `%${search}%`));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await ctx.db
        .select({
          id: invites.id,
          token: invites.token,
          expiresAt: invites.expiresAt,
          createdAt: invites.createdAt,
          usedAt: invites.usedAt,
          usedByEmail: users.email,
        })
        .from(invites)
        .leftJoin(users, eq(invites.usedByUserId, users.id))
        .where(whereClause)
        .orderBy(desc(invites.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1].id : undefined;

      return {
        items: items.map((inv) => {
          let status: "pending" | "used" | "expired";
          if (inv.usedAt) {
            status = "used";
          } else if (inv.expiresAt < now) {
            status = "expired";
          } else {
            status = "pending";
          }

          return {
            id: inv.id,
            token: inv.token,
            expiresAt: inv.expiresAt,
            createdAt: inv.createdAt,
            status,
            usedAt: inv.usedAt,
            usedByEmail: inv.usedByEmail,
          };
        }),
        nextCursor,
      };
    }),

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
      const { inviteId } = input;

      // Delete only if unused
      await ctx.db.delete(invites).where(and(eq(invites.id, inviteId), isNull(invites.usedAt)));

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
          brokenOnly: z.boolean().optional(),
          hasSubscribers: z.boolean().optional(),
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
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? DEFAULT_LIMIT;
      const cursor = input?.cursor;
      const urlFilter = input?.urlFilter;
      const userEmail = input?.userEmail;
      const brokenOnly = input?.brokenOnly;
      const hasSubscribers = input?.hasSubscribers;

      // Subscriber count subquery
      const subscriberCountSq = ctx.db
        .select({ count: count().as("subscriber_count") })
        .from(subscriptions)
        .where(and(eq(subscriptions.feedId, feeds.id), isNull(subscriptions.unsubscribedAt)));

      // Total entry count subquery
      const totalEntryCountSq = ctx.db
        .select({ count: count().as("count") })
        .from(entries)
        .where(eq(entries.feedId, feeds.id));

      // Oldest entry timestamp subquery
      const oldestEntryAtSq = ctx.db
        .select({ minFetchedAt: sql`MIN(${entries.fetchedAt})`.as("min_fetched_at") })
        .from(entries)
        .where(eq(entries.feedId, feeds.id));

      // Entries per week: count / weeks since oldest entry
      const entriesPerWeekExpr = sql<number | null>`
        CASE
          WHEN (${totalEntryCountSq}) = 0 THEN NULL
          WHEN (${oldestEntryAtSq}) IS NULL THEN NULL
          WHEN EXTRACT(EPOCH FROM (NOW() - (${oldestEntryAtSq}))) < 604800 THEN NULL
          ELSE (${totalEntryCountSq})::float / (EXTRACT(EPOCH FROM (NOW() - (${oldestEntryAtSq}))) / 604800.0)
        END
      `;

      const conditions = [];

      // Only web feeds
      conditions.push(eq(feeds.type, "web"));

      // Cursor-based pagination with mixed sort directions:
      // ORDER BY consecutiveFailures DESC, title ASC, id ASC
      // Tuple comparison (<) assumes uniform direction, so we use explicit OR logic.
      if (cursor) {
        conditions.push(
          sql`(
            ${feeds.consecutiveFailures} < (SELECT f2.consecutive_failures FROM feeds f2 WHERE f2.id = ${cursor})
            OR (
              ${feeds.consecutiveFailures} = (SELECT f2.consecutive_failures FROM feeds f2 WHERE f2.id = ${cursor})
              AND (
                COALESCE(${feeds.title}, '') > (SELECT COALESCE(f2.title, '') FROM feeds f2 WHERE f2.id = ${cursor})
                OR (
                  COALESCE(${feeds.title}, '') = (SELECT COALESCE(f2.title, '') FROM feeds f2 WHERE f2.id = ${cursor})
                  AND ${feeds.id} > (SELECT f2.id FROM feeds f2 WHERE f2.id = ${cursor})
                )
              )
            )
          )`
        );
      }

      // URL substring filter (case-insensitive)
      if (urlFilter) {
        conditions.push(ilike(feeds.url, `%${urlFilter}%`));
      }

      // Broken only filter
      if (brokenOnly) {
        conditions.push(gt(feeds.consecutiveFailures, 0));
      }

      // Has subscribers filter: only feeds with active subscribers
      if (hasSubscribers) {
        conditions.push(sql`(${subscriberCountSq}) > 0`);
      }

      // User email filter: feeds that a specific user is subscribed to
      if (userEmail) {
        conditions.push(
          sql`${feeds.id} IN (
            SELECT s.feed_id FROM subscriptions s
            JOIN users u ON u.id = s.user_id
            WHERE u.email ILIKE ${`%${userEmail}%`}
              AND s.unsubscribed_at IS NULL
          )`
        );
      }

      const whereClause = and(...conditions);

      const rows = await ctx.db
        .select({
          feedId: feeds.id,
          title: feeds.title,
          url: feeds.url,
          siteUrl: feeds.siteUrl,
          consecutiveFailures: feeds.consecutiveFailures,
          lastError: feeds.lastError,
          lastFetchedAt: feeds.lastFetchedAt,
          lastEntriesUpdatedAt: feeds.lastEntriesUpdatedAt,
          nextFetchAt: feeds.nextFetchAt,
          websubActive: feeds.websubActive,
          subscriberCount: sql<number>`(${subscriberCountSq})`.as("subscriber_count"),
          lastFetchEntryCount: feeds.lastFetchEntryCount,
          lastFetchSizeBytes: feeds.lastFetchSizeBytes,
          totalEntryCount: sql<number>`(${totalEntryCountSq})`.as("total_entry_count"),
          entriesPerWeek: entriesPerWeekExpr.as("entries_per_week"),
        })
        .from(feeds)
        .where(whereClause)
        .orderBy(desc(feeds.consecutiveFailures), asc(feeds.title), asc(feeds.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1].feedId : undefined;

      return {
        items: items.map((row) => ({
          feedId: row.feedId,
          title: row.title,
          url: row.url,
          siteUrl: row.siteUrl,
          consecutiveFailures: row.consecutiveFailures,
          lastError: row.lastError,
          lastFetchedAt: row.lastFetchedAt,
          lastEntriesUpdatedAt: row.lastEntriesUpdatedAt,
          nextFetchAt: row.nextFetchAt,
          websubActive: row.websubActive,
          subscriberCount: Number(row.subscriberCount),
          lastFetchEntryCount: row.lastFetchEntryCount,
          lastFetchSizeBytes: row.lastFetchSizeBytes,
          totalEntryCount: Number(row.totalEntryCount),
          entriesPerWeek: row.entriesPerWeek != null ? Number(row.entriesPerWeek) : null,
        })),
        nextCursor,
      };
    }),

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
      const now = new Date();

      // Reset the feed's failure counter and schedule immediate fetch
      await ctx.db
        .update(feeds)
        .set({
          consecutiveFailures: 0,
          lastError: null,
          nextFetchAt: now,
          updatedAt: now,
        })
        .where(eq(feeds.id, input.feedId));

      // Also update the job to run immediately
      await ctx.db
        .update(jobs)
        .set({
          consecutiveFailures: 0,
          lastError: null,
          nextRunAt: now,
          updatedAt: now,
        })
        .where(sql`${jobs.payload}->>'feedId' = ${input.feedId} AND ${jobs.type} = 'fetch_feed'`);

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
   * sort orders (see USER_SORT). Includes computed fields: OAuth providers,
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
          sort: USER_SORT.default("activity"),
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
            // Most recent API-token / OAuth-MCP token use. Durable for
            // long-lived API tokens (extension/integrations); for MCP OAuth
            // access tokens it only reflects ~the last day, since those are
            // short-lived and pruned by retention cleanup soon after expiry.
            lastTokenUsedAt: z.date().nullable(),
          })
        ),
        nextCursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? DEFAULT_LIMIT;
      const cursor = input?.cursor;
      const search = input?.search;
      const sort: UserSort = input?.sort ?? "activity";

      // Subquery: OAuth provider names as a JSON array
      const providersSq = ctx.db
        .select({
          providers: sql<
            string[]
          >`COALESCE(json_agg(DISTINCT ${oauthAccounts.provider}), '[]'::json)`.as("providers"),
        })
        .from(oauthAccounts)
        .where(eq(oauthAccounts.userId, users.id));

      // Subquery: count of active subscriptions
      const subscriptionCountSq = ctx.db
        .select({ count: count().as("count") })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, users.id), isNull(subscriptions.unsubscribedAt)));

      // Subquery: count of user_entries
      const entryCountSq = ctx.db
        .select({ count: count().as("count") })
        .from(userEntries)
        .where(eq(userEntries.userId, users.id));

      // Subqueries: most recent token use, tracked separately from session
      // activity. API tokens (extension/integrations) are long-lived so this is
      // durable; OAuth access tokens (remote MCP) are short-lived and pruned by
      // retention, so they only contribute usage from ~the last day.
      const apiTokenLastUsedSq = ctx.db
        .select({ max: max(apiTokens.lastUsedAt).as("max") })
        .from(apiTokens)
        .where(eq(apiTokens.userId, users.id));
      const oauthTokenLastUsedSq = ctx.db
        .select({ max: max(oauthAccessTokens.lastUsedAt).as("max") })
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.userId, users.id));

      const conditions = [];

      // Search by email
      if (search) {
        conditions.push(ilike(users.email, `%${search}%`));
      }

      // Keyset (cursor) pagination. The cursor is a user id; the row it points
      // at is looked up via subquery so we can compare against the sort column.
      // Each branch mirrors its ORDER BY below.
      if (cursor) {
        const cursorActive = sql`(SELECT u2.last_active_at FROM users u2 WHERE u2.id = ${cursor})`;
        const cursorEmail = sql`(SELECT u2.email FROM users u2 WHERE u2.id = ${cursor})`;
        switch (sort) {
          case "created":
            conditions.push(lt(users.id, cursor));
            break;
          case "oldest":
            conditions.push(gt(users.id, cursor));
            break;
          case "email":
            conditions.push(
              sql`(
                ${users.email} > ${cursorEmail}
                OR (${users.email} = ${cursorEmail} AND ${users.id} > ${cursor})
              )`
            );
            break;
          case "activity":
            // ORDER BY last_active_at DESC NULLS LAST, id DESC. When the cursor
            // row has activity, later rows have lower activity (or NULL), or the
            // same activity with a lower id. When the cursor is already in the
            // NULL tail, only lower-id NULL rows remain.
            conditions.push(
              sql`(
                (
                  ${cursorActive} IS NOT NULL
                  AND (
                    ${users.lastActiveAt} < ${cursorActive}
                    OR ${users.lastActiveAt} IS NULL
                    OR (${users.lastActiveAt} = ${cursorActive} AND ${users.id} < ${cursor})
                  )
                )
                OR (
                  ${cursorActive} IS NULL
                  AND ${users.lastActiveAt} IS NULL
                  AND ${users.id} < ${cursor}
                )
              )`
            );
            break;
        }
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const orderBy =
        sort === "created"
          ? [desc(users.id)]
          : sort === "oldest"
            ? [asc(users.id)]
            : sort === "email"
              ? [asc(users.email), asc(users.id)]
              : [sql`${users.lastActiveAt} DESC NULLS LAST`, desc(users.id)];

      const rows = await ctx.db
        .select({
          id: users.id,
          email: users.email,
          createdAt: users.createdAt,
          providers: sql<string[]>`(${providersSq})`.as("providers"),
          subscriptionCount: sql<number>`(${subscriptionCountSq})`.as("subscription_count"),
          entryCount: sql<number>`(${entryCountSq})`.as("entry_count"),
          lastActiveAt: users.lastActiveAt,
          // GREATEST ignores NULLs, so this is the newer of the two, or NULL.
          lastTokenUsedAt:
            sql<Date | null>`GREATEST((${apiTokenLastUsedSq}), (${oauthTokenLastUsedSq}))`.as(
              "last_token_used_at"
            ),
        })
        .from(users)
        .where(whereClause)
        .orderBy(...orderBy)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1].id : undefined;

      return {
        items: items.map((row) => ({
          id: row.id,
          email: row.email,
          createdAt: row.createdAt,
          providers: Array.isArray(row.providers) ? (row.providers as string[]) : ([] as string[]),
          subscriptionCount: Number(row.subscriptionCount),
          entryCount: Number(row.entryCount),
          lastActiveAt: row.lastActiveAt ? new Date(row.lastActiveAt) : null,
          lastTokenUsedAt: row.lastTokenUsedAt ? new Date(row.lastTokenUsedAt) : null,
        })),
        nextCursor,
      };
    }),
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
    .query(async ({ ctx }) => {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Run counts in parallel, combining queries that scan the same table
      const [
        totalUsersResult,
        activeUsersResult,
        feedStatsResult,
        feedsWithSubsResult,
        totalEntriesResult,
        totalSubscriptionsResult,
        pendingInvitesResult,
      ] = await Promise.all([
        // Total users
        ctx.db.select({ count: count() }).from(users),

        // Active users: single scan over the denormalized users.last_active_at
        // (durable across session retention cleanup, unlike a sessions scan).
        ctx.db
          .select({
            active7d: sql<number>`COUNT(*) FILTER (WHERE ${users.lastActiveAt} > ${sevenDaysAgo})`,
            active30d: sql<number>`COUNT(*) FILTER (WHERE ${users.lastActiveAt} > ${thirtyDaysAgo})`,
          })
          .from(users)
          .where(gt(users.lastActiveAt, thirtyDaysAgo)),

        // Feed stats: single scan for total and broken counts
        ctx.db
          .select({
            total: count(),
            broken: sql<number>`COUNT(*) FILTER (WHERE ${feeds.consecutiveFailures} > 0)`,
          })
          .from(feeds)
          .where(eq(feeds.type, "web")),

        // Web feeds with at least one active subscriber
        ctx.db
          .select({ count: sql<number>`COUNT(DISTINCT ${subscriptions.feedId})` })
          .from(subscriptions)
          .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
          .where(and(isNull(subscriptions.unsubscribedAt), eq(feeds.type, "web"))),

        // Total entries
        ctx.db.select({ count: count() }).from(entries),

        // Total active subscriptions
        ctx.db
          .select({ count: count() })
          .from(subscriptions)
          .where(isNull(subscriptions.unsubscribedAt)),

        // Pending invites
        ctx.db
          .select({ count: count() })
          .from(invites)
          .where(and(isNull(invites.usedAt), gt(invites.expiresAt, now))),
      ]);

      return {
        totalUsers: Number(totalUsersResult[0].count),
        activeUsersLast7Days: Number(activeUsersResult[0].active7d),
        activeUsersLast30Days: Number(activeUsersResult[0].active30d),
        totalFeeds: Number(feedStatsResult[0].total),
        totalFeedsWithSubscribers: Number(feedsWithSubsResult[0].count),
        brokenFeeds: Number(feedStatsResult[0].broken),
        totalEntries: Number(totalEntriesResult[0].count),
        totalSubscriptions: Number(totalSubscriptionsResult[0].count),
        pendingInvites: Number(pendingInvitesResult[0].count),
      };
    }),
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
      await publishAnnouncementChanged(await getAnnouncement());
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
