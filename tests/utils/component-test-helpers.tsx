/**
 * Test helpers for component integration tests.
 *
 * Renders React components that embed tRPC queries/mutations against a REAL
 * tRPC React client + real QueryClient, exactly like the app's TRPCProvider —
 * the only difference is a terminating "mock link" that resolves each procedure
 * from a caller-supplied handler map instead of hitting the network. This keeps
 * tRPC's real key hashing, React Query caching, and hook wiring in play (no
 * internal mocks) while letting a test define canned responses per procedure.
 *
 * Usage:
 *   const { calls } = renderWithTrpc(<EditSubscriptionDialog {...props} />, {
 *     handlers: {
 *       "tags.list": () => ({ items: [], uncategorized: {...} }),
 *       "subscriptions.update": (input) => ({ ... }),
 *     },
 *   });
 *   // ... interact, then assert against `calls`.
 */

import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import { trpc } from "@/lib/trpc/client";
import type { AppRouter } from "@/server/trpc/root";

/**
 * Installs a fresh in-memory `localStorage` on the global via `vi.stubGlobal`.
 *
 * jsdom does not reliably expose a global `localStorage` across Node versions
 * (it's absent under Node 26 in CI), and components under test read it directly
 * (show-original preference, expanded tags, sidebar unread-only). Call this in
 * `beforeEach` so every test gets a clean, always-defined store regardless of
 * environment. Mirrors the mock in `useShowOriginalPreference.test.ts`.
 */
export function stubMemoryLocalStorage(): Storage {
  const store = new Map<string, string>();
  const mock: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
  vi.stubGlobal("localStorage", mock);
  return mock;
}

/**
 * A handler for a single tRPC procedure. Receives the procedure input and
 * returns the data the client should observe (sync or async). Throw to simulate
 * a procedure error; a plain Error is wrapped in a TRPCClientError.
 */
export type ProcedureHandler = (input: unknown) => unknown;

/** Map of tRPC procedure path (e.g. "entries.get") to its handler. */
export type ProcedureHandlers = Record<string, ProcedureHandler>;

/** A tRPC operation observed by the mock link. */
export interface RecordedCall {
  path: string;
  type: "query" | "mutation" | "subscription";
  input: unknown;
}

/**
 * Builds a terminating tRPC link that resolves operations from `handlers`.
 * Because there is no HTTP layer, no transformer runs: handler return values
 * reach the hooks as-is (Date objects stay Dates), which matches what the
 * superjson-decoded client would produce. Unhandled procedures error loudly so
 * a test that forgets a handler fails with a clear message instead of hanging.
 */
function mockLink(handlers: ProcedureHandlers, calls: RecordedCall[]): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        calls.push({ path: op.path, type: op.type, input: op.input });

        const handler = handlers[op.path];
        if (!handler) {
          observer.error(
            new TRPCClientError(`No mock handler registered for tRPC procedure "${op.path}"`)
          );
          return;
        }

        let cancelled = false;
        Promise.resolve()
          .then(() => handler(op.input))
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

export interface RenderWithTrpcOptions {
  /** Canned responses keyed by tRPC procedure path. */
  handlers?: ProcedureHandlers;
  /** Extra provider(s) to wrap around the component, inside the tRPC/query context. */
  wrapper?: (children: ReactNode) => ReactElement;
}

export interface RenderWithTrpcResult extends RenderResult {
  /** The QueryClient backing the render — inspect or seed its cache directly. */
  queryClient: QueryClient;
  /** Every tRPC operation the component issued, in order. */
  calls: RecordedCall[];
  /** Convenience: the recorded calls for a given procedure path. */
  callsFor: (path: string) => RecordedCall[];
}

/**
 * Renders `ui` inside a real tRPC + React Query provider whose network layer is
 * the mock link built from `options.handlers`.
 */
export function renderWithTrpc(
  ui: ReactElement,
  options: RenderWithTrpcOptions = {}
): RenderWithTrpcResult {
  const handlers = options.handlers ?? {};
  const calls: RecordedCall[] = [];

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const trpcClient = trpc.createClient({ links: [mockLink(handlers, calls)] });

  function Wrapper({ children }: { children: ReactNode }) {
    const inner = options.wrapper ? options.wrapper(children) : children;
    return (
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{inner}</QueryClientProvider>
      </trpc.Provider>
    );
  }

  const result = render(ui, { wrapper: Wrapper });

  return {
    ...result,
    queryClient,
    calls,
    callsFor: (path: string) => calls.filter((c) => c.path === path),
  };
}
