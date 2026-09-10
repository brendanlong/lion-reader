/**
 * Terminating tRPC link that resolves every operation from an in-process
 * handler map instead of the network.
 *
 * Used wherever the real tRPC React client should run against canned data:
 * the public demo (`src/app/(public)/demo/store.ts`) and the component tests
 * (`tests/utils/component-test-helpers.tsx`). Because there is no HTTP layer,
 * no transformer runs: handler return values reach the hooks as-is (Dates stay
 * Dates), which is what the superjson-decoded client would produce.
 *
 * Unhandled procedures error loudly so a missing handler fails with a clear
 * message instead of hanging a query forever.
 */

import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { AppRouter } from "@/server/trpc/root";

/**
 * A handler for a single tRPC procedure. Receives the procedure input and
 * returns the data the client should observe (sync or async). Throw to simulate
 * a procedure error; use {@link procedureError} to attach a tRPC error code
 * (a plain Error is wrapped in a TRPCClientError without one).
 *
 * The parameter is `never` so a handler may declare its real input type (the
 * demo store types each one from `inferRouterInputs`) — the link trusts the
 * caller's path→input pairing, exactly as the HTTP link trusts the server's.
 */
export type ProcedureHandler = (input: never) => unknown;

/** Map of tRPC procedure path (e.g. "entries.get") to its handler. */
export type ProcedureHandlers = Record<string, ProcedureHandler>;

/** A tRPC operation observed by the link. */
export interface RecordedCall {
  path: string;
  type: "query" | "mutation" | "subscription";
  input: unknown;
}

/**
 * A client-side error carrying `data.code`, shaped like the one the real client
 * surfaces for a server `TRPCError` — so callers that branch on the code (e.g.
 * `error.data?.code === "NOT_FOUND"`) behave the same against a handler.
 *
 * `appErrorCode` is the narrower code our `errorFormatter` adds (see
 * `src/server/trpc/trpc.ts`); pass it for callers that branch on that instead.
 */
export function procedureError(
  code: string,
  message: string,
  appErrorCode?: string
): TRPCClientError<AppRouter> {
  return new TRPCClientError(message, {
    result: { error: { data: { code, appErrorCode } } },
  } as never);
}

export function createHandlerLink(
  handlers: ProcedureHandlers,
  onCall?: (call: RecordedCall) => void
): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        onCall?.({ path: op.path, type: op.type, input: op.input });

        const handler = handlers[op.path];
        if (!handler) {
          observer.error(
            new TRPCClientError(`No handler registered for tRPC procedure "${op.path}"`)
          );
          return;
        }

        let cancelled = false;
        Promise.resolve()
          .then(() => (handler as (input: unknown) => unknown)(op.input))
          .then((data) => {
            if (cancelled) return;
            observer.next({ result: { data } });
            observer.complete();
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            observer.error(
              error instanceof TRPCClientError
                ? error
                : new TRPCClientError(error instanceof Error ? error.message : String(error))
            );
          });

        return () => {
          cancelled = true;
        };
      });
}
