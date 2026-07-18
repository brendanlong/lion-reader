/**
 * Maintenance gate for the custom HTTP server (scripts/server.ts).
 *
 * When maintenance mode is on, every request is checked here before Next.js
 * sees it. Pages get a self-contained 503 HTML page; API routes get a 503 JSON
 * body. A short list of surfaces stays up: the demo (no DB), the admin panel and
 * its session endpoint (so you can turn maintenance back off), the health check,
 * legal pages, and static assets. The main tRPC endpoint is blocked unless the
 * request carries a valid admin session cookie, so the admin panel keeps working
 * while everything else is down.
 *
 * The per-request check is synchronous: a background poller refreshes the flag
 * from Redis into a module variable so we never `await` Redis in the hot path.
 */

import { getMaintenance, type MaintenanceState } from "@/server/services/site-status";
import {
  ADMIN_COOKIE_NAME,
  validateAdminSessionToken,
  validateAdminSecret,
} from "@/server/auth/admin-session";
import { extractBearerToken } from "@/server/auth/bearer";
import { logger } from "@/lib/logger";

export type GateDecision = "allow" | "block-page" | "block-api";

/**
 * Path prefixes that stay reachable during maintenance. The demo is the public
 * face (it never touches Postgres); /admin + /api/admin let an operator toggle
 * maintenance off; /api/health keeps Fly's health checks green; the legal pages
 * and "/" (a lightweight redirector) stay up per the "keep the landing page up"
 * decision.
 */
const EXEMPT_PREFIXES = [
  "/demo",
  "/admin",
  "/api/admin",
  "/api/health",
  // The startup revalidation hook (scripts/server.ts → revalidate-public):
  // secret-guarded, touches no DB, and must work when a process boots while
  // maintenance is on, or login/register would keep serving build-baked
  // config after maintenance ends.
  "/api/internal",
  "/_next",
  "/privacy",
  "/terms",
  "/onnx",
  "/icons",
];

/** Individual exact static paths that must stay reachable. */
const EXEMPT_EXACT = new Set([
  "/",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.webmanifest",
  "/sw.js",
]);

/** A path is treated as a static asset when it ends in a common file extension. */
const STATIC_EXT =
  /\.(?:ico|png|jpg|jpeg|gif|svg|webp|avif|css|js|mjs|map|woff2?|ttf|otf|eot|json|txt|xml|wasm)$/i;

/**
 * Whether the request carries a valid admin credential. Mirrors `adminMiddleware`
 * (src/server/trpc/trpc.ts): either the `admin_session` cookie or a
 * `Bearer <ALLOWLIST_SECRET>` header, so programmatic admins aren't locked out.
 */
function hasValidAdminAuth(cookieHeader?: string, authHeader?: string): boolean {
  if (cookieHeader) {
    for (const part of cookieHeader.split(/;\s*/)) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      if (part.slice(0, eq) !== ADMIN_COOKIE_NAME) continue;
      const value = part.slice(eq + 1);
      if (value && validateAdminSessionToken(value)) return true;
    }
  }
  if (authHeader) {
    const token = extractBearerToken(authHeader);
    if (token && validateAdminSecret(token)) return true;
  }
  return false;
}

/**
 * Decide what to do with a request while maintenance is active. Pure — takes the
 * pathname and the raw Cookie/Authorization headers, returns the decision.
 * Unit-tested.
 */
export function evaluateRequest(
  pathname: string,
  cookieHeader?: string,
  authHeader?: string
): GateDecision {
  if (EXEMPT_EXACT.has(pathname)) return "allow";
  if (EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return "allow";
  }

  const isApi = pathname === "/api" || pathname.startsWith("/api/");

  // The main tRPC endpoint stays open ONLY to a valid admin credential, so the
  // admin panel can read status and toggle maintenance back off.
  if (pathname === "/api/trpc" || pathname.startsWith("/api/trpc/")) {
    return hasValidAdminAuth(cookieHeader, authHeader) ? "allow" : "block-api";
  }

  // Static assets stay up — but ONLY off the API surface. Several authenticated
  // API routes end in a static-looking suffix (the Wallabag compat API uses
  // `.json`), and those must be blocked, so this check runs after the API
  // decisions and never applies under `/api/`.
  if (!isApi && STATIC_EXT.test(pathname)) return "allow";

  return isApi ? "block-api" : "block-page";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DEFAULT_MAINTENANCE_MESSAGE =
  "Lion Reader is temporarily down for scheduled maintenance. We'll be back shortly.";

/**
 * Self-contained maintenance HTML — inline CSS, no app/DB/Next dependency, so it
 * renders even if the rest of the app is broken. Honors light/dark via
 * prefers-color-scheme.
 */
export function renderMaintenanceHtml(message?: string): string {
  const text = escapeHtml(message?.trim() || DEFAULT_MAINTENANCE_MESSAGE);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Down for maintenance · Lion Reader</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 1.5rem; background: #fafafa; color: #27272a;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    max-width: 32rem; width: 100%; text-align: center;
    background: #ffffff; border: 1px solid #e4e4e7; border-radius: 0.75rem;
    padding: 2.5rem 2rem; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  .logo { font-size: 2.5rem; line-height: 1; margin-bottom: 1rem; }
  h1 { font-size: 1.375rem; margin: 0 0 0.75rem; }
  p { margin: 0; font-size: 1rem; line-height: 1.6; color: #52525b; }
  @media (prefers-color-scheme: dark) {
    body { background: #09090b; color: #e4e4e7; }
    .card { background: #18181b; border-color: #27272a; box-shadow: none; }
    p { color: #a1a1aa; }
  }
</style>
</head>
<body>
  <main class="card">
    <div class="logo" role="img" aria-label="Lion">🦁</div>
    <h1>Down for maintenance</h1>
    <p>${text}</p>
  </main>
</body>
</html>`;
}

export function maintenanceJsonBody(message?: string): string {
  return JSON.stringify({
    error: "maintenance",
    message: message?.trim() || DEFAULT_MAINTENANCE_MESSAGE,
  });
}

// --- Background poller (custom-server hot path stays synchronous) -----------

let current: MaintenanceState = { enabled: false, message: "" };
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Synchronous read of the last-polled maintenance state. */
export function getCurrentMaintenance(): MaintenanceState {
  return current;
}

async function refresh(): Promise<void> {
  try {
    current = await getMaintenance();
  } catch (error) {
    // getMaintenance is already fail-safe, but never let a refresh throw.
    logger.error("Maintenance poll failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Start polling Redis for the maintenance flag. Called once from the custom
 * server after Next is prepared. Idempotent. `.unref()` so it never keeps the
 * process alive during shutdown.
 */
export function startMaintenancePoller(intervalMs = 3_000): void {
  if (pollTimer) return;
  void refresh();
  pollTimer = setInterval(() => void refresh(), intervalMs);
  pollTimer.unref?.();
}
