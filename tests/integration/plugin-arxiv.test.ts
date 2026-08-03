/**
 * Integration tests for `fetchArxivPaper`, which combines a paper's two
 * representations into one saved article.
 *
 * The interesting behavior is the combination rules — which page supplies the
 * body, which supplies the metadata, and when a rate limit is fatal. Those are
 * decided by real fetch outcomes, so they're driven against a loopback server
 * (`.env.test` sets ALLOW_PRIVATE_NETWORK_FETCH) rather than mocked.
 *
 * The rate-limit cases are the ones worth having: a 429 must not be swallowed
 * (that re-requests a throttled host via the generic fetch), but it also must
 * not discard a body we already hold.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { fetchArxivPaper } from "../../src/server/plugins/arxiv";
import { HttpFetchError } from "../../src/server/http/fetch";

/** Stands in for the HTML render: real body, no citation tags (as arXiv serves it). */
const RENDER_HTML =
  "<!doctype html><html><head><title>DeepSeek-V3 Technical Report</title></head>" +
  "<body><p>Full paper text.</p></body></html>";

/** Stands in for the abstract page: thin body, full citation metadata. */
const ABS_HTML =
  "<!doctype html><html><head><title>[2412.19437] DeepSeek-V3</title>" +
  '<meta name="citation_title" content="DeepSeek-V3 Technical Report" />' +
  '<meta name="citation_author" content="Liu, Aixin" />' +
  '<meta name="citation_author" content="Feng, Bei" />' +
  '<meta name="citation_abstract" content="We present DeepSeek-V3, a strong MoE model." />' +
  "</head><body><p>Abstract page.</p></body></html>";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/render") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(RENDER_HTML);
    } else if (path === "/abs") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(ABS_HTML);
    } else if (path === "/rate-limited") {
      res.writeHead(429, { "Content-Type": "text/html" });
      res.end("slow down");
    } else {
      // Everything else 404s — arXiv's answer for a paper with no HTML render.
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("fetchArxivPaper", () => {
  it("takes the body from the render and the metadata from the abstract page", async () => {
    const result = await fetchArxivPaper(`${baseUrl}/render`, `${baseUrl}/abs`);

    expect(result?.html).toContain("Full paper text.");
    expect(result?.html).not.toContain("Abstract page.");
    expect(result?.title).toBe("DeepSeek-V3 Technical Report");
    expect(result?.author).toBe("Aixin Liu and Bei Feng");
    expect(result?.excerpt).toBe("We present DeepSeek-V3, a strong MoE model.");
    expect(result?.canonicalUrl).toBe(`${baseUrl}/render`);
  });

  it("falls back to the abstract page as the body when there is no render", async () => {
    const result = await fetchArxivPaper(`${baseUrl}/missing`, `${baseUrl}/abs`);

    expect(result?.html).toContain("Abstract page.");
    // Metadata still comes through — it lives on the page we ended up using.
    expect(result?.title).toBe("DeepSeek-V3 Technical Report");
    expect(result?.canonicalUrl).toBe(`${baseUrl}/abs`);
  });

  it("uses the abstract page when the plugin was given no render URL", async () => {
    const result = await fetchArxivPaper(null, `${baseUrl}/abs`);

    expect(result?.html).toContain("Abstract page.");
    expect(result?.title).toBe("DeepSeek-V3 Technical Report");
  });

  it("returns null when neither page exists, so the save falls back", async () => {
    expect(await fetchArxivPaper(`${baseUrl}/missing`, `${baseUrl}/gone`)).toBeNull();
    expect(await fetchArxivPaper(null, null)).toBeNull();
  });

  it("keeps the render when the abstract page is rate limited", async () => {
    // The regression this guards: Promise.all would abandon a body we already
    // hold. There is nothing to re-request, so the save should succeed with
    // Readability filling in the metadata.
    const result = await fetchArxivPaper(`${baseUrl}/render`, `${baseUrl}/rate-limited`);

    expect(result?.html).toContain("Full paper text.");
    expect(result?.title).toBeNull();
    expect(result?.author).toBeNull();
    expect(result?.excerpt).toBeNull();
  });

  it("keeps the abstract page when the render is rate limited", async () => {
    const result = await fetchArxivPaper(`${baseUrl}/rate-limited`, `${baseUrl}/abs`);

    expect(result?.html).toContain("Abstract page.");
    expect(result?.title).toBe("DeepSeek-V3 Technical Report");
  });

  it("rethrows the rate limit when it left us with no content at all", async () => {
    // Swallowing here would drop the save into acquireArticleContent's generic
    // fetch, re-requesting the host that just throttled us.
    await expect(
      fetchArxivPaper(`${baseUrl}/rate-limited`, `${baseUrl}/rate-limited`)
    ).rejects.toBeInstanceOf(HttpFetchError);

    await expect(
      fetchArxivPaper(`${baseUrl}/rate-limited`, `${baseUrl}/missing`)
    ).rejects.toSatisfy((e) => e instanceof HttpFetchError && e.isRateLimited());
  });
});
