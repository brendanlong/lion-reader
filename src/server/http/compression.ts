/**
 * Response compression for SSR streaming pages.
 *
 * Applies zstd, brotli, gzip, or deflate compression (in order of preference)
 * to chunked/streaming responses. Non-streaming responses (those with a
 * Content-Length header) are left uncompressed for Fly.io's edge to handle.
 */

import { createBrotliCompress, createGzip, createDeflate, constants } from "node:zlib";
import type { Transform } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

// Check if zstd is available at runtime (Node.js 22+)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const zlib = require("node:zlib") as Record<string, unknown>;
const hasZstd = typeof zlib.createZstdCompress === "function";

type CompressionEncoding = "zstd" | "br" | "gzip" | "deflate";

interface EncodingPreference {
  encoding: string;
  quality: number;
}

/**
 * Parse the Accept-Encoding header into a list of encodings with quality values.
 */
function parseAcceptEncoding(header: string): EncodingPreference[] {
  return header
    .split(",")
    .map((part) => {
      const [encoding, ...params] = part.trim().split(";");
      let quality = 1;
      for (const param of params) {
        const match = param.trim().match(/^q=(.+)$/);
        if (match) {
          quality = parseFloat(match[1]);
          if (isNaN(quality)) quality = 0;
        }
      }
      return { encoding: encoding.trim().toLowerCase(), quality };
    })
    .filter((e) => e.quality > 0);
}

/** Preferred encodings in order: zstd > brotli > gzip > deflate */
const ENCODING_PRIORITY: CompressionEncoding[] = ["zstd", "br", "gzip", "deflate"];

/**
 * Select the best compression encoding based on Accept-Encoding header.
 * Returns null if no acceptable encoding is found.
 */
function selectEncoding(acceptEncoding: string): CompressionEncoding | null {
  const preferences = parseAcceptEncoding(acceptEncoding);
  const accepted = new Set(preferences.map((p) => p.encoding));

  for (const encoding of ENCODING_PRIORITY) {
    if (encoding === "zstd" && !hasZstd) continue;
    if (accepted.has(encoding)) return encoding;
  }

  return null;
}

/**
 * Create a compression transform stream for the given encoding.
 *
 * Uses moderate compression levels optimized for streaming:
 * - zstd: default level 3 (fast, good ratio)
 * - brotli: level 4 (good balance for real-time streaming)
 * - gzip/deflate: default level 6
 */
function createCompressor(encoding: CompressionEncoding): Transform {
  switch (encoding) {
    case "zstd":
      return (zlib.createZstdCompress as () => Transform)();
    case "br":
      return createBrotliCompress({
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 4,
        },
      });
    case "gzip":
      return createGzip();
    case "deflate":
      return createDeflate();
  }
}

/**
 * Check if a header value is present in either the explicit headers object
 * passed to writeHead or the headers already set on the response.
 */
function getHeader(
  res: ServerResponse,
  name: string,
  explicitHeaders?: Record<string, unknown> | unknown[]
): unknown {
  // Check headers passed directly to writeHead
  if (explicitHeaders) {
    if (Array.isArray(explicitHeaders)) {
      // Raw header array: [key, value, key, value, ...]
      for (let i = 0; i < explicitHeaders.length; i += 2) {
        const key = explicitHeaders[i];
        if (typeof key === "string" && key.toLowerCase() === name) {
          return explicitHeaders[i + 1];
        }
      }
    } else {
      // Header object: case-insensitive lookup
      for (const key of Object.keys(explicitHeaders)) {
        if (key.toLowerCase() === name) return explicitHeaders[key];
      }
    }
  }

  // Check headers already set on the response
  return res.getHeader(name);
}

/**
 * Wrap an HTTP response to apply compression for streaming responses.
 *
 * Only compresses chunked responses (no Content-Length set). Responses that
 * already have a Content-Length or Content-Encoding are passed through
 * unchanged.
 */
export function maybeCompressResponse(req: IncomingMessage, res: ServerResponse): void {
  const acceptEncoding = req.headers["accept-encoding"];
  if (!acceptEncoding) return;

  const selectedEncoding = selectEncoding(acceptEncoding);
  if (!selectedEncoding) return;

  // Capture in a const that TypeScript can narrow (closures don't narrow)
  const encoding: CompressionEncoding = selectedEncoding;

  // Save original methods
  const _writeHead = res.writeHead;
  const _write = res.write;
  const _end = res.end;

  let compressor: Transform | null = null;
  let decided = false;
  let ended = false;

  function decide(explicitHeaders?: Record<string, unknown> | unknown[]): void {
    if (decided) return;
    decided = true;

    // Skip if already encoded
    if (getHeader(res, "content-encoding", explicitHeaders)) return;

    // Skip non-streaming responses (Fly.io handles these)
    if (getHeader(res, "content-length", explicitHeaders) != null) return;

    // Create compression stream
    compressor = createCompressor(encoding);

    // Update headers
    res.setHeader("Content-Encoding", encoding as string);
    res.removeHeader("Content-Length");

    // Ensure Vary includes Accept-Encoding
    const vary = res.getHeader("vary");
    if (!vary) {
      res.setHeader("Vary", "Accept-Encoding");
    } else if (typeof vary === "string" && !vary.toLowerCase().includes("accept-encoding")) {
      res.setHeader("Vary", `${vary}, Accept-Encoding`);
    }

    // Pipe compressed output to the original response with backpressure handling
    const comp = compressor;
    comp.on("data", (chunk: Buffer) => {
      // If write() returns false, the downstream is backed up. Pause the
      // compressor and resume once the response drains.
      if (!_write.call(res, chunk, "binary", () => {})) {
        comp.pause();
        res.once("drain", () => comp.resume());
      }
    });

    compressor.on("end", () => {
      ended = true;
      _end.call(res, null, "binary", () => {});
    });
  }

  // Intercept writeHead to check headers before they're sent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.writeHead = function (statusCode: number, ...args: any[]) {
    // Parse the overloaded writeHead signature:
    // writeHead(statusCode, headers?)
    // writeHead(statusCode, statusMessage, headers?)
    let headers: Record<string, unknown> | unknown[] | undefined;
    if (typeof args[0] === "string") {
      headers = args[1] as Record<string, unknown> | unknown[] | undefined;
    } else {
      headers = args[0] as Record<string, unknown> | unknown[] | undefined;
    }

    decide(headers);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_writeHead as any).apply(res, [statusCode, ...args]);
  } as typeof res.writeHead;

  // Intercept write to route through compressor
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.write = function (chunk: any, encodingOrCb?: any, cb?: any) {
    if (!decided) decide();
    if (compressor) {
      compressor.write(chunk, encodingOrCb, cb);
      // Flush the compressor after each write so compressed data is sent to the
      // browser immediately. Without this, zlib/brotli buffer internally and the
      // browser receives nothing until end(), defeating SSR streaming.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (compressor as any).flush();
      // Always return true: backpressure between the compressor and the
      // original response is handled by the data handler (pause/drain).
      // Returning compressor.write()'s value would deadlock when used with
      // pipe(), because pipe() waits for drain on `res` but the compressed
      // output is small enough that `res`'s buffer never fills.
      return true;
    }
    return _write.call(res, chunk, encodingOrCb, cb);
  } as typeof res.write;

  // Intercept end to flush and close compressor
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  res.end = function (chunk?: any, encodingOrCb?: any, cb?: any) {
    if (!decided) decide();
    if (compressor) {
      // Prevent double-end if compressor already ended the response
      if (ended) return res;

      if (chunk != null) {
        compressor.end(chunk, encodingOrCb, cb);
      } else {
        compressor.end();
      }
      return res;
    }
    return _end.call(res, chunk, encodingOrCb, cb);
  } as typeof res.end;
}
