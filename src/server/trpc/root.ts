/**
 * Root tRPC Router
 *
 * This is the main router that combines all sub-routers.
 * It's used by the API route handler and exported for type inference.
 */

import { createTRPCRouter, createCallerFactory } from "./trpc";
import {
  authRouter,
  usersRouter,
  subscriptionsRouter,
  entriesRouter,
  feedsRouter,
} from "./routers";

/**
 * The root router that combines all sub-routers.
 * Add new routers here as they are implemented.
 */
export const appRouter = createTRPCRouter({
  auth: authRouter,
  users: usersRouter,
  subscriptions: subscriptionsRouter,
  entries: entriesRouter,
  feeds: feedsRouter,
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
