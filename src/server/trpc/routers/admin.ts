/**
 * Admin Router
 *
 * Handles admin operations: invite management, feed health monitoring, and user listing.
 * All endpoints require ALLOWLIST_SECRET Bearer token.
 */

import { z } from "zod";
import { eq, and, isNull, isNotNull, sql, desc, asc, lt, gt, ilike, count, max } from "drizzle-orm";
import crypto from "crypto";

import { createTRPCRouter, adminProcedure } from "../trpc";
import { errors } from "../errors";
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
  sessions,
  userEntries,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { parseTimestamptzOrNull } from "@/server/db/temporal";
import { createCursorCodec, cursorUuid } from "@/server/services/cursor";
import {
  getMaintenanceRaw,
  getAnnouncementRaw,
  getAnnouncement,
  setMaintenance,
  setAnnouncement,
  ANNOUNCEMENT_LEVELS,
} from "@/server/services/site-status";
import { publishAnnouncementChanged } from "@/server/redis/pubsub";
import { logger } from "@/lib/logger";

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

/** Shared pagination input schema; `cursor` is an opaque codec-encoded keyset tuple */
const paginationInput = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

/** Keyset cursor matching the invite list's ORDER BY id DESC. */
const inviteCursor = createCursorCodec(z.object({ id: cursorUuid }));

/** Keyset cursor matching the feed list's ORDER BY failures DESC, COALESCE(title, '') ASC, id ASC. */
const adminFeedCursor = createCursorCodec(
  z.object({
    failures: z.number().int(),
    title: z.string(),
    id: cursorUuid,
  })
);

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

/**
 * Keyset cursor for the admin user list. Tagged with its sort so a cursor from
 * one ordering can't be replayed against another.
 */
const adminUserCursor = createCursorCodec(
  z.discriminatedUnion("sort", [
    z.object({ sort: z.literal("created"), id: cursorUuid }),
    z.object({ sort: z.literal("oldest"), id: cursorUuid }),
    z.object({ sort: z.literal("email"), email: z.string(), id: cursorUuid }),
    z.object({
      sort: z.literal("activity"),
      // Full-precision ISO instant (see "Timestamp cursors" in src/server/CLAUDE.md).
      lastActiveAt: z
        .string()
        .refine((ts) => !Number.isNaN(Date.parse(ts)))
        .nullable(),
      id: cursorUuid,
    }),
  ])
);

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

      if (cursor) {
        conditions.push(lt(invites.id, inviteCursor.decode(cursor).id));
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
      const nextCursor = hasMore
        ? inviteCursor.encode({ id: items[items.length - 1].id })
        : undefined;

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

          return { ...inv, status };
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

      // ORDER BY consecutiveFailures DESC, title ASC, id ASC. Tuple comparison
      // assumes uniform direction, so spell out the mixed-direction keyset.
      if (cursor) {
        const after = adminFeedCursor.decode(cursor);
        conditions.push(
          sql`(
            ${feeds.consecutiveFailures} < ${after.failures}
            OR (
              ${feeds.consecutiveFailures} = ${after.failures}
              AND (
                COALESCE(${feeds.title}, '') > ${after.title}
                OR (COALESCE(${feeds.title}, '') = ${after.title} AND ${feeds.id} > ${after.id})
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
        // Must match the cursor comparison above exactly: the cursor compares
        // COALESCE(title, ''), so ordering by the bare column (Postgres
        // `ASC` = NULLS LAST) would sort untitled feeds after every titled one
        // while the cursor sorts them first, making them unreachable past the
        // first page.
        .orderBy(
          desc(feeds.consecutiveFailures),
          sql`COALESCE(${feeds.title}, '') ASC`,
          asc(feeds.id)
        )
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const lastFeed = items[items.length - 1];
      const nextCursor = hasMore
        ? adminFeedCursor.encode({
            failures: lastFeed.consecutiveFailures,
            title: lastFeed.title ?? "",
            id: lastFeed.feedId,
          })
        : undefined;

      return {
        items: items.map((row) => ({
          ...row,
          subscriberCount: Number(row.subscriberCount),
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
            // Most recent programmatic (API) access: API-token / OAuth-MCP
            // token use, or Google Reader compat-API polling (a scoped session).
            // Durable for long-lived API tokens (extension/integrations); for
            // MCP OAuth access tokens and Google Reader sessions it reflects
            // only recent use, since those are pruned by retention cleanup soon
            // after expiry.
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

      // Subqueries: most recent programmatic (API) access, tracked separately
      // from human session activity. Three sources:
      // - API tokens (extension/integrations) — long-lived, so durable.
      // - OAuth access tokens (remote MCP) — short-lived and pruned by
      //   retention, so they only contribute usage from ~the last day.
      // - Scoped sessions — the Google Reader compat API mints one per login
      //   (scopes IS NOT NULL). A native app polls it in the background, which
      //   isn't real reader activity, so updateLastActiveAt bumps only
      //   sessions.last_active_at for those and leaves users.last_active_at
      //   alone. Surfacing MAX here reclassifies that polling as API usage.
      //   Durable only while the session lives (retention deletes it ~a day
      //   after its 30-day expiry), but an actively-syncing client keeps a live
      //   session, so it stays current exactly when it matters.
      const apiTokenLastUsedSq = ctx.db
        .select({ max: max(apiTokens.lastUsedAt).as("max") })
        .from(apiTokens)
        .where(eq(apiTokens.userId, users.id));
      const oauthTokenLastUsedSq = ctx.db
        .select({ max: max(oauthAccessTokens.lastUsedAt).as("max") })
        .from(oauthAccessTokens)
        .where(eq(oauthAccessTokens.userId, users.id));
      const scopedSessionLastActiveSq = ctx.db
        .select({ max: max(sessions.lastActiveAt).as("max") })
        .from(sessions)
        .where(and(eq(sessions.userId, users.id), isNotNull(sessions.scopes)));

      const conditions = [];

      // Search by email
      if (search) {
        conditions.push(ilike(users.email, `%${search}%`));
      }

      // Keyset (cursor) pagination; each branch mirrors its ORDER BY below.
      if (cursor) {
        const after = adminUserCursor.decode(cursor);
        if (after.sort !== sort) {
          throw errors.validation("Cursor does not match the requested sort");
        }
        switch (after.sort) {
          case "created":
            conditions.push(lt(users.id, after.id));
            break;
          case "oldest":
            conditions.push(gt(users.id, after.id));
            break;
          case "email":
            conditions.push(
              sql`(
                ${users.email} > ${after.email}
                OR (${users.email} = ${after.email} AND ${users.id} > ${after.id})
              )`
            );
            break;
          case "activity":
            // ORDER BY last_active_at DESC NULLS LAST, id DESC. When the cursor
            // row has activity, later rows have lower activity (or NULL), or the
            // same activity with a lower id. When the cursor is already in the
            // NULL tail, only lower-id NULL rows remain.
            conditions.push(
              after.lastActiveAt !== null
                ? sql`(
                    ${users.lastActiveAt} < ${after.lastActiveAt}::timestamptz
                    OR ${users.lastActiveAt} IS NULL
                    OR (${users.lastActiveAt} = ${after.lastActiveAt}::timestamptz AND ${users.id} < ${after.id})
                  )`
                : sql`(${users.lastActiveAt} IS NULL AND ${users.id} < ${after.id})`
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
          // Raw driver string (the app pool's timestamptz parser) so the cursor
          // keeps microseconds that the Date above truncates.
          lastActiveAtRaw: sql<string | null>`${users.lastActiveAt}`,
          // GREATEST ignores NULLs, so this is the newest of the three, or NULL.
          lastTokenUsedAt:
            sql<Date | null>`GREATEST((${apiTokenLastUsedSq}), (${oauthTokenLastUsedSq}), (${scopedSessionLastActiveSq}))`.as(
              "last_token_used_at"
            ),
        })
        .from(users)
        .where(whereClause)
        .orderBy(...orderBy)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? encodeUserCursor(sort, items[items.length - 1]) : undefined;

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

function encodeUserCursor(
  sort: UserSort,
  row: { id: string; email: string; lastActiveAtRaw: string | null }
): string {
  switch (sort) {
    case "created":
    case "oldest":
      return adminUserCursor.encode({ sort, id: row.id });
    case "email":
      return adminUserCursor.encode({ sort, email: row.email, id: row.id });
    case "activity":
      return adminUserCursor.encode({
        sort,
        lastActiveAt: parseTimestamptzOrNull(row.lastActiveAtRaw)?.toString() ?? null,
        id: row.id,
      });
  }
}

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
        // This counts real reader activity only — Google Reader compat-API
        // polling is a scoped session that never bumps users.last_active_at, so
        // native-app-only users don't inflate these counts (see
        // updateLastActiveAt).
        ctx.db
          .select({
            active7d: sql<number>`COUNT(*) FILTER (WHERE ${users.lastActiveAt} > ${sevenDaysAgo})`,
            // No FILTER needed: the WHERE below already restricts the scan to
            // the 30-day window (and `gt` excludes NULL last_active_at).
            active30d: count(),
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
      // The broadcast is best-effort: a Redis publish failure must not fail an
      // otherwise-successful save (clients still pick it up on next page load).
      try {
        await publishAnnouncementChanged(await getAnnouncement());
      } catch (error) {
        logger.error("Failed to broadcast announcement change", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
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
