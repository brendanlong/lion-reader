/**
 * tRPC Server-Side Client
 *
 * For calling tRPC procedures from React Server Components.
 * This bypasses HTTP and calls procedures directly.
 */

import { headers, cookies } from "next/headers";
import { cache } from "react";
import { createCaller, type Context } from "@/server/trpc";
import { db } from "@/server/db";
import { sessions, users } from "@/server/db/schema";
import { eq, and, isNull, gt } from "drizzle-orm";
import crypto from "crypto";

/**
 * Create the context for server-side calls.
 * This is cached per request to avoid multiple session lookups.
 */
const createServerContext = cache(async (): Promise<Context> => {
  const headerStore = await headers();
  const cookieStore = await cookies();

  // Get session token from cookie
  const token = cookieStore.get("session")?.value;

  let session: Context["session"] = null;

  if (token) {
    // Hash the token to compare with stored hash
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // Find session by token hash
    const result = await db
      .select({
        session: sessions,
        user: users,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date())
        )
      )
      .limit(1);

    if (result.length > 0) {
      session = result[0];
    }
  }

  return {
    db,
    session,
    headers: new Headers(Object.fromEntries(headerStore.entries())),
  };
});

/**
 * Server-side tRPC caller.
 * Use this in React Server Components to call tRPC procedures.
 *
 * @example
 * ```tsx
 * // In a server component:
 * const entries = await api.entries.list({ limit: 20 });
 * ```
 */
export const api = async () => {
  const ctx = await createServerContext();
  return createCaller(ctx);
};
