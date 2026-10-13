/**
 * Unit tests for the timing middleware's Sentry reporting of failed procedures (#1752).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/nextjs";
import { TRPCError } from "@trpc/server";
import type { Context } from "@/server/trpc/context";
import { createCallerFactory, createTRPCRouter, publicProcedure } from "@/server/trpc/trpc";
import { errors, markReported } from "@/server/trpc/errors";

vi.mock("@sentry/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/nextjs")>()),
  captureException: vi.fn(),
}));

const alreadyReported = errors.internal("reported by the thrower");
markReported(alreadyReported);

const router = createTRPCRouter({
  resolverThrows: publicProcedure.query(() => {
    throw new Error("resolver boom");
  }),
  laterMiddlewareThrows: publicProcedure
    .use(() => {
      throw new Error("middleware boom");
    })
    .query(() => "unreachable"),
  internalError: publicProcedure.query(() => {
    throw errors.internal("internal boom");
  }),
  notFound: publicProcedure.query(() => {
    throw errors.entryNotFound();
  }),
  siteBlocked: publicProcedure.query(() => {
    throw errors.siteBlocked("https://example.com", 403);
  }),
  alreadyReported: publicProcedure.query(() => {
    throw alreadyReported;
  }),
});

const caller = createCallerFactory(router)({
  session: null,
  apiToken: null,
  authType: null,
  scopes: [],
  headers: new Headers(),
  sessionToken: null,
} as unknown as Context);

describe("timingMiddleware error reporting", () => {
  beforeEach(() => {
    vi.mocked(Sentry.captureException).mockClear();
  });

  it.each([
    ["resolverThrows", "resolver boom"],
    ["laterMiddlewareThrows", "middleware boom"],
    ["internalError", "internal boom"],
  ] as const)("reports a server error from %s once", async (procedure, message) => {
    await expect(caller[procedure]()).rejects.toThrow(message);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [reported, hint] = vi.mocked(Sentry.captureException).mock.calls[0];
    expect(reported).toBeInstanceOf(TRPCError);
    expect((reported as TRPCError).message).toBe(message);
    expect(hint).toMatchObject({ tags: { trpcPath: procedure, trpcType: "query" } });
  });

  it.each(["notFound", "siteBlocked", "alreadyReported"] as const)(
    "doesn't report %s",
    async (procedure) => {
      await expect(caller[procedure]()).rejects.toThrow();

      expect(Sentry.captureException).not.toHaveBeenCalled();
    }
  );
});
