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
import { validateSession } from "@/server/auth";

/**
 * Create the context for server-side calls.
 * This is cached per request to avoid multiple session lookups.
 * Uses Redis cache for session validation (same as HTTP requests).
 */
const createServerContext = cache(async (): Promise<Context> => {
  const headerStore = await headers();
  const cookieStore = await cookies();

  // Get session token from cookie
  const token = cookieStore.get("session")?.value ?? null;

  // Validate session using the shared session validation logic
  // This uses Redis cache for fast lookups
  const session = token ? await validateSession(token) : null;

  return {
    db,
    session,
    apiToken: null,
    authType: session ? "session" : null,
    scopes: [],
    sessionToken: token,
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
