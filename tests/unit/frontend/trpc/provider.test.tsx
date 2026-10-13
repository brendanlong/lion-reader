/**
 * @vitest-environment jsdom
 */

/**
 * The HTTP link chain batches queries issued together into one request, except
 * those marked UNBATCHED, which go out on their own so a speculative fetch
 * can't hold up the batch's response.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import superjson from "superjson";
import { TRPCProvider } from "@/lib/trpc/provider";
import { trpc, UNBATCHED } from "@/lib/trpc/client";

const entry = (id: string) => superjson.serialize({ entry: { id } });

/** Answers each tRPC GET with an `entries.get`-shaped result per call. */
function stubFetch() {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      urls.push(url);
      const inputs = JSON.parse(url.searchParams.get("input")!) as
        Record<string, { json: { id: string } }> | { json: { id: string } };
      const body =
        url.searchParams.get("batch") === "1"
          ? Object.values(inputs as Record<string, { json: { id: string } }>).map((i) => ({
              result: { data: entry(i.json.id) },
            }))
          : { result: { data: entry((inputs as { json: { id: string } }).json.id) } };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    })
  );
  return urls;
}

function Entries() {
  trpc.entries.get.useQuery({ id: "open" });
  trpc.entries.get.useQuery({ id: "other" });
  trpc.entries.get.useQuery({ id: "neighbour" }, UNBATCHED);
  return null;
}

describe("TRPCProvider links", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends UNBATCHED queries in their own request", async () => {
    const urls = stubFetch();

    render(
      <TRPCProvider>
        <Entries />
      </TRPCProvider>
    );

    await waitFor(() => expect(urls).toHaveLength(2));
    const requestedIds = urls.map((url) =>
      [...url.searchParams.get("input")!.matchAll(/"id":"(\w+)"/g)].map((m) => m[1]).sort()
    );
    expect(requestedIds).toEqual(expect.arrayContaining([["open", "other"], ["neighbour"]]));
  });
});
