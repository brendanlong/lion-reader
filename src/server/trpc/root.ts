/**
 * Root tRPC Router
 *
 * This is the main router that combines all sub-routers.
 * It's used by the API route handler and exported for type inference.
 */

import { createTRPCRouter, createCallerFactory } from "./trpc";
import { adminRouter } from "./routers/admin";
import { apiTokensRouter } from "./routers/api-tokens";
import { authRouter } from "./routers/auth";
import { usersRouter } from "./routers/users";
import { subscriptionsRouter } from "./routers/subscriptions";
import { entriesRouter } from "./routers/entries";
import { feedsRouter } from "./routers/feeds";
import { tagsRouter } from "./routers/tags";
import { savedRouter } from "./routers/saved";
import { narrationRouter } from "./routers/narration";
import { summarizationRouter } from "./routers/summarization";
import { ingestAddressesRouter } from "./routers/ingestAddresses";
import { blockedSendersRouter } from "./routers/blockedSenders";
import { brokenFeedsRouter } from "./routers/brokenFeeds";
import { feedStatsRouter } from "./routers/feedStats";
import { importsRouter } from "./routers/imports";
import { syncRouter } from "./routers/sync";

/**
 * The root router that combines all sub-routers.
 * Add new routers here as they are implemented.
 */
export const appRouter = createTRPCRouter({
  admin: adminRouter,
  apiTokens: apiTokensRouter,
  auth: authRouter,
  users: usersRouter,
  subscriptions: subscriptionsRouter,
  entries: entriesRouter,
  feeds: feedsRouter,
  tags: tagsRouter,
  saved: savedRouter,
  narration: narrationRouter,
  summarization: summarizationRouter,
  ingestAddresses: ingestAddressesRouter,
  blockedSenders: blockedSendersRouter,
  brokenFeeds: brokenFeedsRouter,
  feedStats: feedStatsRouter,
  imports: importsRouter,
  sync: syncRouter,
});

/**
 * Export type definition of the API.
 * This is used by the client for type inference.
 */
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the router.
 * Useful for calling procedures from server components or API routes.
 */
export const createCaller = createCallerFactory(appRouter);
