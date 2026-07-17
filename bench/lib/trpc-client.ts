/**
 * A tRPC client factory for load generation. Uses the app's OWN transformer
 * (superjson) and router types, so the wire format is guaranteed identical to
 * production — no hand-rolled batch/superjson encoding to get subtly wrong.
 *
 * We use httpLink (UNBATCHED) rather than the prod httpBatchLink so each action
 * is exactly one HTTP request; this gives clean per-endpoint latency and lets
 * the driver control offered load precisely. The server does the same
 * per-procedure work either way. (Batching is noted as a caveat in the report.)
 *
 * All HTTP goes through a single shared undici Agent with a large connection
 * pool so the LOAD GENERATOR never becomes the bottleneck (Node's built-in
 * fetch uses a separate bundled undici, so we call undici's fetch explicitly
 * and pass the dispatcher rather than relying on setGlobalDispatcher).
 */

import { createTRPCClient, httpLink } from "@trpc/client";
import { Agent, fetch as undiciFetch } from "undici";
import superjson from "superjson";
import type { AppRouter } from "../../src/server/trpc/root";

export type BenchClient = ReturnType<typeof createTRPCClient<AppRouter>>;

const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS ?? 2048);
export const dispatcher = new Agent({
  connections: MAX_CONNECTIONS,
  pipelining: 1,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 120_000,
});

/** Builds a client authenticated as one seeded user via its session cookie. */
export function makeClient(baseUrl: string, sessionToken: string): BenchClient {
  return createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${baseUrl}/api/trpc`,
        transformer: superjson,
        headers() {
          return { cookie: `session=${sessionToken}` };
        },
        // undici fetch + shared dispatcher (large pool). Cast to the fetch shape
        // tRPC expects; undici's Response is spec-compatible for tRPC's needs.
        fetch: ((input: string | URL, init?: RequestInit) =>
          undiciFetch(input, {
            ...(init as object),
            dispatcher,
          })) as unknown as typeof fetch,
      }),
    ],
  });
}

/**
 * Opens an SSE connection (GET /api/v1/events) and holds it open, discarding
 * data, until aborted. Mirrors the browser's single long-lived EventSource.
 * Returns a function that closes it.
 */
export function openSse(baseUrl: string, sessionToken: string): () => void {
  const controller = new AbortController();
  void undiciFetch(`${baseUrl}/api/v1/events`, {
    method: "GET",
    headers: { cookie: `session=${sessionToken}`, accept: "text/event-stream" },
    signal: controller.signal,
    dispatcher,
  })
    .then(async (res) => {
      if (!res.body) return;
      const reader = res.body.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    })
    .catch(() => {
      /* aborted or connection dropped — expected */
    });
  return () => controller.abort();
}
