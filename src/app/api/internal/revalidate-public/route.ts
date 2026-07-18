/**
 * Internal endpoint: re-render the statically-prerendered public pages.
 *
 * The `(public)/(auth)` pages bake the signup/provider config into their
 * prerendered HTML (issue #1359). `next build` runs with build-machine env —
 * in CI/Docker that is NOT the runtime env — so the custom server calls this
 * once per process startup (scripts/server.ts) to invalidate those pages;
 * the next request re-renders them in the running server with real env and
 * re-caches the result. The config can't change after startup, so
 * startup-time freshness is exactly enough.
 *
 * Auth: requires the `x-internal-secret` header to equal
 * `INTERNAL_REVALIDATE_SECRET`, which scripts/server.ts generates fresh per
 * process before Next boots — the value never leaves the process, so only the
 * server's own startup hook can call this. With the env var unset (e.g. a
 * deployment not using our custom server), the endpoint always refuses.
 */

import { revalidatePath } from "next/cache";
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** Paths whose prerendered HTML embeds runtime (not build-time) config. */
const STARTUP_RENDERED_PATHS = ["/login", "/register"];

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.INTERNAL_REVALIDATE_SECRET;
  const provided = request.headers.get("x-internal-secret");
  if (!secret || !provided) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  for (const path of STARTUP_RENDERED_PATHS) {
    revalidatePath(path);
  }

  return NextResponse.json({ revalidated: STARTUP_RENDERED_PATHS });
}
