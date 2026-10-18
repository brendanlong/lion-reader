/**
 * The signed-in session of the request a Server Component is rendering. Kept out
 * of `session.ts` because `next/headers` only works inside a Next.js request.
 */

import { cookies } from "next/headers";
import { validateSession, type SessionData } from "@/server/auth/session";
import { getSessionCookie } from "@/server/auth/session-cookie";

/** The request's valid session and its token, or null when it has none. */
export async function getRequestSession(): Promise<{ token: string; session: SessionData } | null> {
  const token = getSessionCookie(await cookies());
  if (!token) return null;
  const session = await validateSession(token);
  return session ? { token, session } : null;
}
