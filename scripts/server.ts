/**
 * Custom Next.js server with streaming-compatible compression.
 *
 * Fly.io's reverse proxy buffers responses to compress them, which breaks
 * React streaming SSR (used for progressive prefetch delivery). By compressing
 * responses ourselves with per-write flushing, each HTML chunk is compressed
 * and sent immediately. Fly.io sees the Content-Encoding header and passes
 * the response through without buffering.
 *
 * Compression preference: brotli > gzip > deflate (negotiated via
 * Accept-Encoding). Brotli gives ~15-20% better compression than gzip.
 * Zstd is not available in Node.js's zlib module.
 *
 * Usage:
 *   node dist/server.js
 *
 * Environment variables:
 *   PORT - HTTP port (default: 3000)
 *   HOSTNAME - Bind address (default: 0.0.0.0)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { constants } from "node:zlib";
import next from "next";
import compression from "compression";

const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

// Streaming-compatible compression with per-write flushing.
//
// For gzip/deflate: Z_SYNC_FLUSH flushes compressed data after each
// res.write() call, so streaming SSR chunks are sent immediately.
//
// For brotli: BROTLI_OPERATION_FLUSH is the equivalent — it flushes
// the brotli encoder after each write. Quality 4 balances compression
// ratio and CPU cost for real-time streaming.
//
// The compression package negotiates the best encoding from the client's
// Accept-Encoding header, preferring brotli > gzip > deflate.
//
// The compression package's types expect Express req/res, but it works fine
// with plain Node.js http types at runtime (it only uses standard methods
// like req.headers, res.setHeader, res.write, res.end).
const compress = compression({
  // Flush gzip/deflate after every write for streaming
  flush: constants.Z_SYNC_FLUSH,
  // Flush brotli after every write for streaming
  brotli: {
    flush: constants.BROTLI_OPERATION_FLUSH,
    params: {
      // Quality 4 is a good balance for streaming: fast enough to not add
      // latency, but still ~15-20% smaller than gzip
      [constants.BROTLI_PARAM_QUALITY]: 4,
    },
  },
}) as (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

app.prepare().then(() => {
  const server = createServer((req, res) => {
    compress(req, res, () => {
      // Next.js calls res.flushHeaders() (in pipe-readable.js) to send headers
      // before the first streaming write. The compression middleware hooks into
      // res.writeHead() via on-headers, but flushHeaders() bypasses writeHead
      // entirely in Node.js — it directly flushes the output buffer. This means
      // the compression stream is never created.
      //
      // Fix: redirect flushHeaders() through writeHead() so the compression
      // middleware's onHeaders callback fires and sets up the compression stream.
      //
      // This must be done AFTER the compression middleware runs (inside next())
      // so that res.writeHead is already patched by on-headers.
      //
      // Next.js also explicitly calls res.flush() after each write (pipe-readable.js
      // line 78) to flush the compression stream, so streaming works end-to-end.
      const origFlushHeaders = res.flushHeaders;
      res.flushHeaders = function () {
        if (!this.headersSent) {
          this.writeHead(this.statusCode);
        }
        return origFlushHeaders.call(this);
      };

      handle(req, res);
    });
  });

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
