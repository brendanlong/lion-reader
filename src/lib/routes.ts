/**
 * Shared route constants (client- and server-safe, no heavy imports — this is
 * pulled into the proxy bundle).
 */

/**
 * Route prefix the public demo mounts the SPA under. The demo renders the
 * app's own routing/state tree against canned data; `AppLocationProvider`
 * strips this prefix so the tree sees app-relative paths (`/all`, `/tag/:id`).
 */
export const DEMO_BASE_PATH = "/demo";

/**
 * Where anonymous visitors land: the demo with the welcome article open.
 * Used by the proxy fast-path redirect for `/` (src/proxy.ts), the dynamic
 * `/` fallback page, and the `/demo` index redirect — one constant so the
 * three entry points can't drift.
 */
export const DEMO_LANDING_PATH = `${DEMO_BASE_PATH}/all?entry=welcome`;
