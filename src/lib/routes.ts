/**
 * Shared route constants (client- and server-safe, no heavy imports — this is
 * pulled into the proxy bundle).
 */

/**
 * Where anonymous visitors land: the demo with the welcome article open.
 * Used by the proxy fast-path redirect for `/` (src/proxy.ts), the dynamic
 * `/` fallback page, and the `/demo` index redirect — one constant so the
 * three entry points can't drift.
 */
export const DEMO_LANDING_PATH = "/demo/all?entry=welcome";
