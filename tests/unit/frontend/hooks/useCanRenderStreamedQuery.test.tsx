/**
 * useCanRenderStreamedQuery on the server: a query the page streamed while
 * pending holds its Suspense boundary until the result lands, so the content
 * (not the skeleton) is in the HTML; a query nobody streamed renders the
 * skeleton without suspending or fetching. Server-rendered with React's
 * streaming renderer through the same dehydrate/hydrate path the app uses.
 */

import { describe, it, expect, vi } from "vitest";
import { Suspense } from "react";
import { renderToReadableStream } from "react-dom/server";
import {
  QueryClient,
  QueryClientProvider,
  dehydrate,
  hydrate,
  useQueryClient,
} from "@tanstack/react-query";
import { useCanRenderStreamedQuery } from "@/lib/hooks/useIsHydrated";

const QUERY_KEY = ["entries", "list"];

function List() {
  const canRender = useCanRenderStreamedQuery(QUERY_KEY);
  const data = useQueryClient().getQueryData<string[]>(QUERY_KEY);
  if (!canRender || !data) return <p>skeleton</p>;
  return <p>{data.join(",")}</p>;
}

async function renderToHtml(queryClient: QueryClient): Promise<string> {
  const stream = await renderToReadableStream(
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={<p>fallback</p>}>
        <List />
      </Suspense>
    </QueryClientProvider>
  );
  await stream.allReady;
  return new Response(stream).text();
}

describe("useCanRenderStreamedQuery (server render)", () => {
  it("renders a streamed query's data once its prefetch resolves", async () => {
    // The page's QueryClient prefetches without awaiting and dehydrates the
    // pending query; the render's QueryClient hydrates it, as HydrateClient does.
    let resolveFetch!: (entries: string[]) => void;
    const pageClient = new QueryClient();
    void pageClient.prefetchQuery({
      queryKey: QUERY_KEY,
      queryFn: () => new Promise<string[]>((resolve) => (resolveFetch = resolve)),
    });
    const renderClient = new QueryClient();
    hydrate(renderClient, dehydrate(pageClient, { shouldDehydrateQuery: () => true }));

    const html = renderToHtml(renderClient);
    resolveFetch(["first", "second"]);

    expect(await html).toContain("first,second");
    expect(await html).not.toContain("skeleton");
  });

  it("renders the skeleton without suspending or fetching when nothing was streamed", async () => {
    const queryFn = vi.fn(async () => ["unused"]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { queryFn } } });

    const html = await renderToHtml(queryClient);

    expect(html).toContain("skeleton");
    expect(html).not.toContain("fallback");
    expect(queryFn).not.toHaveBeenCalled();
  });
});
