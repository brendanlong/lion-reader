/**
 * tRPC Module Exports
 *
 * Main entry point for tRPC server-side code.
 */

// Router and procedures
export { createTRPCRouter, publicProcedure, protectedProcedure, mergeRouters } from "./trpc";

// Context
export { createContext, type Context, type SessionData } from "./context";

// Root router
export { appRouter, createCaller, type AppRouter } from "./root";

// Error utilities
export { errors, ErrorCodes, createError, type ErrorCode } from "./errors";
