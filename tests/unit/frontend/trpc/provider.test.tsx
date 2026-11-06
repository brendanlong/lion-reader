/**
 * @vitest-environment jsdom
 */

/**
 * The HTTP link chain batches calls issued together into one request and
 * streams queries' results back as each finishes, so a slow query doesn't
 * hold up the rest. Calls that may set a cookie (the auth router, mutations)
 * go in a plain batch, whose headers wait for its calls.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { z } from "zod";
import { TRPCProvider } from "@/lib/trpc/provider";
import { trpc } from "@/lib/trpc/client";

/** Stands in for the app router: real tRPC, procedures named like the app's. */
function serveTestRouter(slow: Promise<void>) {
  const t = initTRPC.create({ transformer: superjson });
  const router = t.router({
    entries: t.router({
      get: t.procedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
        if (input.id === "slow") await slow;
        return { entry: { id: input.id } };
      }),
      markRead: t.procedure.input(z.unknown()).mutation(() => ({ ok: true })),
    }),
    auth: t.router({
      providers: t.procedure.query(() => ({ providers: [] })),
    }),
  });

  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(new URL(String(input), "http://localhost"), init);
      requests.push(request);
      return fetchRequestHandler({ endpoint: "/api/trpc", req: request, router });
    })
  );
  return requests;
}

function Entry({ id }: { id: string }) {
  const { data } = trpc.entries.get.useQuery({ id });
  return data ? <p>loaded {data.entry.id}</p> : null;
}

function isStreamed(request: Request): boolean {
  return request.headers.get("trpc-accept") === "application/jsonl";
}

describe("TRPCProvider links", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers a batched query before a slow one in the same batch finishes", async () => {
    let finishSlow!: () => void;
    const requests = serveTestRouter(new Promise<void>((resolve) => (finishSlow = resolve)));

    render(
      <TRPCProvider>
        <Entry id="fast" />
        <Entry id="slow" />
      </TRPCProvider>
    );

    expect(await screen.findByText("loaded fast")).toBeInTheDocument();
    expect(screen.queryByText("loaded slow")).not.toBeInTheDocument();
    expect(requests).toHaveLength(1);

    finishSlow();
    expect(await screen.findByText("loaded slow")).toBeInTheDocument();
  });

  it("sends auth queries and mutations in a plain batch", async () => {
    const requests = serveTestRouter(Promise.resolve());
    function Calls() {
      trpc.auth.providers.useQuery();
      const markRead = trpc.entries.markRead.useMutation();
      return <button onClick={() => markRead.mutate({ entries: [], read: true })}>mark</button>;
    }

    render(
      <TRPCProvider>
        <Calls />
      </TRPCProvider>
    );
    screen.getByRole("button").click();

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests.map(isStreamed)).toEqual([false, false]);
  });
});
