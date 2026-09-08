/**
 * Test helpers for component integration tests.
 *
 * Renders React components that embed tRPC queries/mutations against a REAL
 * tRPC React client + real QueryClient, exactly like the app's TRPCProvider —
 * the only difference is the terminating handler link (`createHandlerLink`,
 * the same one the public demo runs on) that resolves each procedure from a
 * caller-supplied handler map instead of hitting the network. This keeps
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
import {
  render,
  renderHook,
  type RenderResult,
  type RenderHookResult,
} from "@testing-library/react";
import { vi } from "vitest";
import { trpc } from "@/lib/trpc/client";
import {
  createHandlerLink,
  type ProcedureHandlers,
  type RecordedCall,
} from "@/lib/trpc/handler-link";

export type { ProcedureHandler, ProcedureHandlers, RecordedCall } from "@/lib/trpc/handler-link";

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
 * Builds the real tRPC + React Query provider wrapper whose network layer is the
 * mock link resolving procedures from `options.handlers`. Shared by
 * `renderWithTrpc` (components) and `renderHookWithTrpc` (hooks) so both exercise
 * the same real client wiring.
 */
function createTrpcWrapper(options: RenderWithTrpcOptions = {}): {
  Wrapper: (props: { children: ReactNode }) => ReactElement;
  queryClient: QueryClient;
  calls: RecordedCall[];
  callsFor: (path: string) => RecordedCall[];
} {
  const handlers = options.handlers ?? {};
  const calls: RecordedCall[] = [];

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const trpcClient = trpc.createClient({
    links: [createHandlerLink(handlers, (call) => calls.push(call))],
  });

  function Wrapper({ children }: { children: ReactNode }) {
    const inner = options.wrapper ? options.wrapper(children) : children;
    return (
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>{inner}</QueryClientProvider>
      </trpc.Provider>
    );
  }

  return {
    Wrapper,
    queryClient,
    calls,
    callsFor: (path: string) => calls.filter((c) => c.path === path),
  };
}

/**
 * Renders `ui` inside a real tRPC + React Query provider whose network layer is
 * the mock link built from `options.handlers`.
 */
export function renderWithTrpc(
  ui: ReactElement,
  options: RenderWithTrpcOptions = {}
): RenderWithTrpcResult {
  const { Wrapper, queryClient, calls, callsFor } = createTrpcWrapper(options);
  const result = render(ui, { wrapper: Wrapper });

  return { ...result, queryClient, calls, callsFor };
}

export interface RenderHookWithTrpcResult<TResult> extends RenderHookResult<TResult, unknown> {
  /** The QueryClient backing the render — inspect or seed its cache directly. */
  queryClient: QueryClient;
  /** Every tRPC operation the hook issued, in order. */
  calls: RecordedCall[];
  /** Convenience: the recorded calls for a given procedure path. */
  callsFor: (path: string) => RecordedCall[];
}

/**
 * Renders a hook inside the same real tRPC + React Query provider as
 * `renderWithTrpc`, so hooks that call `trpc.useUtils()`/`useMutation` run
 * against real client wiring with a mock network link.
 */
export function renderHookWithTrpc<TResult>(
  hook: () => TResult,
  options: RenderWithTrpcOptions = {}
): RenderHookWithTrpcResult<TResult> {
  const { Wrapper, queryClient, calls, callsFor } = createTrpcWrapper(options);
  const result = renderHook(hook, { wrapper: Wrapper });

  return { ...result, queryClient, calls, callsFor };
}
