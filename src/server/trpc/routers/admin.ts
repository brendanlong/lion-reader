/**
 * Admin Router
 *
 * Handles admin operations: invite management, feed health monitoring, and user listing.
 * All endpoints require ALLOWLIST_SECRET Bearer token.
 */

import { z } from "zod";
import { eq, and, isNull, sql, desc, asc, lt, gt, ilike, count } from "drizzle-orm";
import crypto from "crypto";

import { createTRPCRouter, adminProcedure } from "../trpc";
import {
  feeds,
  subscriptions,
  users,
  invites,
  jobs,
  oauthAccounts,
  userEntries,
  userScoreModels,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";

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

      // Subscriber count subquery
      const subscriberCountSq = ctx.db
        .select({ count: count().as("subscriber_count") })
        .from(subscriptions)
        .where(and(eq(subscriptions.feedId, feeds.id), isNull(subscriptions.unsubscribedAt)));

      // Entries per week: totalEntryCount / (seconds since creation / 604800)
      // Returns null if totalEntryCount is 0 or feed was just created
      const entriesPerWeekExpr = sql<number | null>`
        CASE
          WHEN ${feeds.totalEntryCount} = 0 THEN NULL
          WHEN EXTRACT(EPOCH FROM (NOW() - ${feeds.createdAt})) < 604800 THEN NULL
          ELSE ${feeds.totalEntryCount}::float / (EXTRACT(EPOCH FROM (NOW() - ${feeds.createdAt})) / 604800.0)
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
          totalEntryCount: feeds.totalEntryCount,
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
          totalEntryCount: row.totalEntryCount,
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
   * Supports search by email (partial match, case-insensitive).
   * Includes computed fields: OAuth providers, subscription count, entry count,
   * scoring model stats, and total entry size estimate.
   * Ordered by createdAt DESC (newest first).
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
            scoringModelSize: z.number().nullable(),
            scoringModelMemoryEstimate: z.number().nullable(),
          })
        ),
        nextCursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? DEFAULT_LIMIT;
      const cursor = input?.cursor;
      const search = input?.search;

      // Subquery: OAuth provider names as a JSON array
      const providersSq = sql<string[]>`
        COALESCE(
          (SELECT json_agg(DISTINCT ${oauthAccounts.provider})
           FROM ${oauthAccounts}
           WHERE ${oauthAccounts.userId} = ${users.id}),
          '[]'::json
        )
      `;

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

      // Subquery: scoring model size (length of model_data text)
      const scoringModelSizeSq = sql<number | null>`
        (SELECT LENGTH(${userScoreModels.modelData})
         FROM ${userScoreModels}
         WHERE ${userScoreModels.userId} = ${users.id})
      `;

      // Subquery: scoring model memory estimate based on vocabulary size
      // Rough estimate: vocabulary entries * ~100 bytes each
      const scoringModelMemoryEstimateSq = sql<number | null>`
        (SELECT jsonb_array_length(
           CASE WHEN jsonb_typeof(${userScoreModels.vocabulary}) = 'object'
                THEN jsonb_path_query_array(${userScoreModels.vocabulary}, '$.*')
                ELSE '[]'::jsonb
           END
         ) * 100
         FROM ${userScoreModels}
         WHERE ${userScoreModels.userId} = ${users.id})
      `;

      const conditions = [];

      // Cursor-based pagination: id < cursor (order by id DESC, since UUIDv7 is time-ordered)
      if (cursor) {
        conditions.push(lt(users.id, cursor));
      }

      // Search by email
      if (search) {
        conditions.push(ilike(users.email, `%${search}%`));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await ctx.db
        .select({
          id: users.id,
          email: users.email,
          createdAt: users.createdAt,
          providers: providersSq.as("providers"),
          subscriptionCount: sql<number>`(${subscriptionCountSq})`.as("subscription_count"),
          entryCount: sql<number>`(${entryCountSq})`.as("entry_count"),
          scoringModelSize: scoringModelSizeSq.as("scoring_model_size"),
          scoringModelMemoryEstimate: scoringModelMemoryEstimateSq.as(
            "scoring_model_memory_estimate"
          ),
        })
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.id))
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
          scoringModelSize: row.scoringModelSize != null ? Number(row.scoringModelSize) : null,
          scoringModelMemoryEstimate:
            row.scoringModelMemoryEstimate != null ? Number(row.scoringModelMemoryEstimate) : null,
        })),
        nextCursor,
      };
    }),
} as const;

// ============================================================================
// ROUTER
// ============================================================================

export const adminRouter = createTRPCRouter({
  // Invites
  ...inviteEndpoints,
  // Feed health
  ...feedHealthEndpoints,
  // Users
  ...userEndpoints,
});
