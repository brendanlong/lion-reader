/**
 * The admin user list: every account, with per-user activity and usage totals.
 */

import { z } from "zod";
import { and, asc, count, desc, eq, gt, ilike, isNotNull, isNull, lt, max, sql } from "drizzle-orm";
import type { Database } from "@/server/db";
import {
  apiTokens,
  oauthAccessTokens,
  oauthAccounts,
  sessions,
  subscriptions,
  userEntries,
  users,
} from "@/server/db/schema";
import { containsPattern } from "@/server/db/like";
import { parseTimestamptzOrNull } from "@/server/db/temporal";
import { errors } from "@/server/errors";
import { createCursorCodec, cursorUuid } from "@/server/services/cursor";
import { isUserManagedSubscription } from "@/server/services/subscriptions";

/**
 * Sort options for the admin user list. Each sorts by a durable, indexable
 * column on the users row so keyset (cursor) pagination stays correct:
 * - `activity`: most recent activity first (last_active_at DESC NULLS LAST)
 * - `created`:  newest accounts first (UUIDv7 id DESC)
 * - `oldest`:   oldest accounts first (id ASC)
 * - `email`:    email A→Z
 */
export const ADMIN_USER_SORTS = ["activity", "created", "oldest", "email"] as const;
type AdminUserSort = (typeof ADMIN_USER_SORTS)[number];

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
      // Full-precision ISO instant (see "Ordering & Pagination" in src/server/CLAUDE.md).
      lastActiveAt: z.iso.datetime({ offset: true }).nullable(),
      id: cursorUuid,
    }),
  ])
);

interface ListAdminUsersParams {
  limit: number;
  cursor?: string;
  /** Partial, case-insensitive email match. */
  search?: string;
  sort: AdminUserSort;
}

interface AdminUser {
  id: string;
  email: string;
  createdAt: Date;
  providers: string[];
  subscriptionCount: number;
  entryCount: number;
  lastActiveAt: Date | null;
  /**
   * Most recent programmatic (API) access: API-token / OAuth-MCP token use, or
   * Google Reader compat-API polling (a scoped session). Durable for long-lived
   * API tokens (extension/integrations); for MCP OAuth access tokens and Google
   * Reader sessions it reflects only recent use, since those are pruned by
   * retention cleanup soon after expiry.
   */
  lastTokenUsedAt: Date | null;
}

export async function listAdminUsers(
  db: Database,
  { limit, cursor, search, sort }: ListAdminUsersParams
): Promise<{ items: AdminUser[]; nextCursor?: string }> {
  // Subquery: OAuth provider names as a JSON array
  const providersSq = db
    .select({
      providers: sql<
        string[]
      >`COALESCE(json_agg(DISTINCT ${oauthAccounts.provider}), '[]'::json)`.as("providers"),
    })
    .from(oauthAccounts)
    .where(eq(oauthAccounts.userId, users.id));

  // Subquery: count of active subscriptions
  const subscriptionCountSq = db
    .select({ count: count().as("count") })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, users.id),
        isNull(subscriptions.unsubscribedAt),
        isUserManagedSubscription()
      )
    );

  // Subquery: count of user_entries
  // eslint-disable-next-line no-restricted-syntax -- an admin's per-user row total, not an unread count
  const entryCountSq = db
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
  const apiTokenLastUsedSq = db
    .select({ max: max(apiTokens.lastUsedAt).as("max") })
    .from(apiTokens)
    .where(eq(apiTokens.userId, users.id));
  const oauthTokenLastUsedSq = db
    .select({ max: max(oauthAccessTokens.lastUsedAt).as("max") })
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.userId, users.id));
  const scopedSessionLastActiveSq = db
    .select({ max: max(sessions.lastActiveAt).as("max") })
    .from(sessions)
    .where(and(eq(sessions.userId, users.id), isNotNull(sessions.scopes)));

  const conditions = [];

  if (search) {
    conditions.push(ilike(users.email, containsPattern(search)));
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

  const rows = await db
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
}

function encodeUserCursor(
  sort: AdminUserSort,
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
