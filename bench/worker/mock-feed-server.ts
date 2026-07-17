/**
 * A local mock feed server for the worker throughput benchmark. Serves valid
 * RSS 2.0 so the worker's real fetch → parse → process → sanitize → fanout path
 * runs end-to-end, without hitting any remote server (the worker must run with
 * ALLOW_PRIVATE_NETWORK_FETCH=true to reach 127.0.0.1).
 *
 * Conditional-GET aware: once the worker has stored our stable ETag, a re-poll
 * sends `If-None-Match` and we return 304 — that's the steady-state case (most
 * real polls find nothing new). A first poll (no If-None-Match) returns 200 with
 * `itemsPerFeed` items — the "fresh"/catch-up case (full parse + fanout).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const STABLE_ETAG = '"bench-v1"';

function buildRss(feedPath: string, items: number): string {
  const now = new Date().toUTCString();
  const entries: string[] = [];
  for (let i = 0; i < items; i++) {
    // guid stable per (feed, item) so a re-poll with changed body would dedup by
    // content_hash; but re-polls are 304 here so this mainly keeps items valid.
    const guid = `${feedPath}#item-${i}`;
    entries.push(
      `<item>` +
        `<title>Benchmark entry ${i}</title>` +
        `<link>http://127.0.0.1/article/${i}</link>` +
        `<guid isPermaLink="false">${guid}</guid>` +
        `<pubDate>${now}</pubDate>` +
        `<description><![CDATA[<p>Paragraph one with a <a href="http://example.com">link</a> and <strong>bold</strong> text. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p><p>Second paragraph of body content for entry ${i}.</p>]]></description>` +
        `</item>`
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0"><channel>` +
    `<title>Bench Feed ${feedPath}</title>` +
    `<link>http://127.0.0.1/</link>` +
    `<description>worker benchmark feed</description>` +
    entries.join("") +
    `</channel></rss>`
  );
}

export interface MockFeedServer {
  port: number;
  server: Server;
  stats: () => { served200: number; served304: number };
  reset: () => void;
}

export function startMockFeedServer(opts: {
  itemsPerFeed: number;
  latencyMs: number;
}): Promise<MockFeedServer> {
  let served200 = 0;
  let served304 = 0;

  const server = createServer((req, res) => {
    const respond = () => {
      const inm = req.headers["if-none-match"];
      if (inm && inm.includes("bench-v1")) {
        served304++;
        res.writeHead(304, { ETag: STABLE_ETAG });
        res.end();
        return;
      }
      served200++;
      const body = buildRss(req.url ?? "/feed", opts.itemsPerFeed);
      res.writeHead(200, {
        "Content-Type": "application/rss+xml; charset=utf-8",
        ETag: STABLE_ETAG,
      });
      res.end(body);
    };
    if (opts.latencyMs > 0) setTimeout(respond, opts.latencyMs);
    else respond();
  });

  // Large backlog so concurrent worker connections don't get ECONNREFUSED.
  server.maxConnections = 10_000;

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        server,
        stats: () => ({ served200, served304 }),
        reset: () => {
          served200 = 0;
          served304 = 0;
        },
      });
    });
  });
}
