import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_SECONDS,
  createAdminSessionToken,
  validateAdminSecret,
  validateAdminSessionToken,
} from "@/server/auth/admin-session";
import { signupConfig } from "@/server/config/env";
import { checkRouteRateLimit } from "@/server/rate-limit";

/**
 * POST /api/admin/session - Exchange admin secret for an httpOnly session cookie.
 */
export async function POST(request: NextRequest): Promise<Response> {
  if (!signupConfig.allowlistSecret) {
    return NextResponse.json({ error: "Admin not configured" }, { status: 404 });
  }

  // Rate limit by IP using the "expensive" tier (same as login/register)
  const rateLimitResponse = await checkRouteRateLimit(request, "expensive", { json: true });
  if (rateLimitResponse) return rateLimitResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !("secret" in body) || typeof body.secret !== "string") {
    return NextResponse.json({ error: "Missing secret" }, { status: 400 });
  }

  if (!validateAdminSecret(body.secret)) {
    return NextResponse.json({ error: "Invalid admin secret" }, { status: 401 });
  }

  const token = createAdminSessionToken();
  const isProduction = process.env.NODE_ENV === "production";

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE_NAME, token, {
    path: "/",
    maxAge: ADMIN_SESSION_TTL_SECONDS,
    sameSite: "lax",
    httpOnly: true,
    secure: isProduction,
  });

  return response;
}

/**
 * DELETE /api/admin/session - Clear admin session cookie.
 */
export async function DELETE(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE_NAME, "", {
    path: "/",
    maxAge: 0,
    httpOnly: true,
  });
  return response;
}

/**
 * GET /api/admin/session - Check if current admin session is valid.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(ADMIN_COOKIE_NAME)?.value;
  if (token && validateAdminSessionToken(token)) {
    return NextResponse.json({ authenticated: true });
  }
  return NextResponse.json({ authenticated: false }, { status: 401 });
}
