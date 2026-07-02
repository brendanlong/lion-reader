/**
 * Sentry Edge Configuration
 *
 * This file configures the initialization of Sentry for edge features (middleware, edge routes).
 * Loaded from src/instrumentation.ts (edge runtime).
 * https://docs.sentry.io/platforms/javascript/guides/nextjs/
 */

import { initSentry } from "./src/server/sentry";

initSentry();
