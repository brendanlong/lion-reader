/**
 * Sentry Server Configuration
 *
 * This file configures the initialization of Sentry on the server.
 * The config added here applies to all server-side code.
 * Loaded from src/instrumentation.ts (nodejs runtime).
 * https://docs.sentry.io/platforms/javascript/guides/nextjs/
 */

import { initSentry } from "./src/server/sentry";

initSentry();
