/**
 * Integration tests for `fetchArxivPaper`, which combines a paper's
 * representations (HTML render, abstract page, PDF) into one saved article.
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
import { articleContentFromAcquired } from "../../src/server/services/article-content";
import { buildArticleFields } from "../../src/server/services/saved-content";
import { buildPdf, textPage } from "../utils/pdf";

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

/** The PDF's own Info title, which the abstract page's must beat. */
const PDF = buildPdf(
  [textPage(["Full paper text from the PDF, long enough to read as a real article body."])],
  { info: { Title: "main.tex" } }
);

let server: Server;
let baseUrl: string;
const requested404s: string[] = [];

/** `fetchArxivPaper`'s URLs, each a path on the loopback server or null. */
function urls(
  render: string | null,
  abs: string | null,
  pdf: string | null = null
): Parameters<typeof fetchArxivPaper>[0] {
  const at = (path: string | null): string | null => (path ? `${baseUrl}${path}` : null);
  return { renderUrl: at(render), absUrl: at(abs), pdfUrl: at(pdf) };
}

function asHtml(result: Awaited<ReturnType<typeof fetchArxivPaper>>) {
  if (!result || "pdf" in result) throw new Error(`expected HTML content, got ${result}`);
  return result;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/render") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(RENDER_HTML);
    } else if (path === "/abs") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(ABS_HTML);
    } else if (path === "/pdf") {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(PDF);
    } else if (path === "/rate-limited") {
      res.writeHead(429, { "Content-Type": "text/html" });
      res.end("slow down");
    } else {
      // Everything else 404s — arXiv's answer for a paper with no HTML render.
      requested404s.push(path);
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
    const result = asHtml(await fetchArxivPaper(urls("/render", "/abs", "/pdf")));

    expect(result.html).toContain("Full paper text.");
    expect(result.html).not.toContain("Abstract page.");
    expect(result.title).toBe("DeepSeek-V3 Technical Report");
    expect(result.author).toBe("Aixin Liu and Bei Feng");
    expect(result.excerpt).toBe("We present DeepSeek-V3, a strong MoE model.");
    expect(result.canonicalUrl).toBe(`${baseUrl}/render`);
  });

  it("falls back to the PDF when there is no render, keeping the abstract page's metadata", async () => {
    const result = await fetchArxivPaper(urls("/missing", "/abs", "/pdf"));
    if (!result || !("pdf" in result)) throw new Error("expected the PDF");

    expect(result.pdf.equals(PDF)).toBe(true);
    expect(result.finalUrl).toBe(`${baseUrl}/pdf`);

    // Converted like any PDF, but titled and summarized from the abstract page
    // rather than the PDF's Info dictionary.
    const fields = await buildArticleFields(
      await articleContentFromAcquired(
        { kind: "pdf", pdf: result.pdf, finalUrl: result.finalUrl, plugin: result },
        { offload: true }
      ),
      {},
      { objectsPrefix: "uploads/test/" }
    );
    expect(fields.contentCleaned).toContain("Full paper text from the PDF");
    expect(fields.title).toBe("DeepSeek-V3 Technical Report");
    expect(fields.author).toBe("Aixin Liu and Bei Feng");
    expect(fields.summary).toBe("We present DeepSeek-V3, a strong MoE model.");
  });

  it("falls back to the abstract page as the body when there is no render or PDF", async () => {
    const result = asHtml(await fetchArxivPaper(urls("/missing", "/abs", "/no-pdf")));

    expect(result.html).toContain("Abstract page.");
    // Metadata still comes through — it lives on the page we ended up using.
    expect(result.title).toBe("DeepSeek-V3 Technical Report");
    expect(result.canonicalUrl).toBe(`${baseUrl}/abs`);
  });

  it("uses the abstract page when the plugin was given only its URL", async () => {
    const result = asHtml(await fetchArxivPaper(urls(null, "/abs")));

    expect(result.html).toContain("Abstract page.");
    expect(result.title).toBe("DeepSeek-V3 Technical Report");
  });

  it("returns null when nothing exists, so the save falls back", async () => {
    expect(await fetchArxivPaper(urls("/missing", "/gone", "/no-pdf"))).toBeNull();
    expect(await fetchArxivPaper(urls(null, null))).toBeNull();
  });

  it("keeps the render when the abstract page is rate limited", async () => {
    // The regression this guards: Promise.all would abandon a body we already
    // hold. There is nothing to re-request, so the save should succeed with
    // Readability filling in the metadata.
    const result = asHtml(await fetchArxivPaper(urls("/render", "/rate-limited")));

    expect(result.html).toContain("Full paper text.");
    expect(result.title).toBeNull();
    expect(result.author).toBeNull();
    expect(result.excerpt).toBeNull();
  });

  it("keeps the abstract page, without requesting the PDF, when the render is rate limited", async () => {
    requested404s.length = 0;
    const result = asHtml(await fetchArxivPaper(urls("/rate-limited", "/abs", "/pdf-probe")));

    expect(result.html).toContain("Abstract page.");
    expect(result.title).toBe("DeepSeek-V3 Technical Report");
    expect(requested404s).not.toContain("/pdf-probe");
  });

  it("keeps the abstract page when the PDF is rate limited", async () => {
    const result = asHtml(await fetchArxivPaper(urls("/missing", "/abs", "/rate-limited")));

    expect(result.html).toContain("Abstract page.");
  });

  it("rethrows the rate limit when it left us with no content at all", async () => {
    // Swallowing here would drop the save into acquireArticleContent's generic
    // fetch, re-requesting the host that just throttled us.
    const isRateLimit = (e: unknown) => e instanceof HttpFetchError && e.isRateLimited();
    await expect(fetchArxivPaper(urls("/rate-limited", "/rate-limited", "/pdf"))).rejects.toSatisfy(
      isRateLimit
    );
    await expect(fetchArxivPaper(urls("/rate-limited", "/missing", "/pdf"))).rejects.toSatisfy(
      isRateLimit
    );
    await expect(fetchArxivPaper(urls("/missing", "/gone", "/rate-limited"))).rejects.toSatisfy(
      isRateLimit
    );
  });
});
