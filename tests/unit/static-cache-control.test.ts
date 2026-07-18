/**
 * Unit tests for neutralizing Next's static-prerender shared-cache lifetime in
 * the custom server. Exercises both channels a response might set Cache-Control
 * through: res.setHeader(...) and headers passed to res.writeHead(...).
 */

import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import {
  neutralizeStaticSharedCache,
  PUBLIC_PRERENDER_CACHE_CONTROL,
} from "../../src/server/http/static-cache-control";

/** A minimal ServerResponse stand-in that records what setHeader/writeHead saw. */
function fakeResponse() {
  const headers: Record<string, unknown> = {};
  const res = {
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    setHeaders(batch: Headers | Map<string, unknown>) {
      for (const [name, value] of batch) headers[String(name).toLowerCase()] = value;
      return this;
    },
    writeHead() {
      return this;
    },
  };
  return { res: res as unknown as ServerResponse, headers };
}

describe("neutralizeStaticSharedCache — setHeader", () => {
  it("rewrites Next's fully-static prerender lifetime to private, no-cache", () => {
    const { res, headers } = fakeResponse();
    neutralizeStaticSharedCache(res);

    res.setHeader("Cache-Control", "s-maxage=31536000");

    expect(headers["cache-control"]).toBe(PUBLIC_PRERENDER_CACHE_CONTROL);
  });

  it("rewrites even when other directives ride along", () => {
    const { res, headers } = fakeResponse();
    neutralizeStaticSharedCache(res);

    res.setHeader("Cache-Control", "s-maxage=31536000, stale-while-revalidate=59");

    expect(headers["cache-control"]).toBe(PUBLIC_PRERENDER_CACHE_CONTROL);
  });

  it("matches the header name case-insensitively", () => {
    const { res, headers } = fakeResponse();
    neutralizeStaticSharedCache(res);

    res.setHeader("cache-control", "s-maxage=31536000");

    expect(headers["cache-control"]).toBe(PUBLIC_PRERENDER_CACHE_CONTROL);
  });

  it("leaves dynamic pages' private, no-store untouched", () => {
    const { res, headers } = fakeResponse();
    neutralizeStaticSharedCache(res);

    res.setHeader("Cache-Control", "private, no-store");

    expect(headers["cache-control"]).toBe("private, no-store");
  });

  it("leaves immutable static-asset caching untouched (no s-maxage=31536000)", () => {
    const { res, headers } = fakeResponse();
    neutralizeStaticSharedCache(res);

    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    expect(headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("passes non-Cache-Control headers through unchanged", () => {
    const { res, headers } = fakeResponse();
    neutralizeStaticSharedCache(res);

    res.setHeader("Content-Type", "text/html; charset=utf-8");

    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
  });
});

describe("neutralizeStaticSharedCache — setHeaders (batch)", () => {
  it("rewrites Cache-Control in a Headers batch", () => {
    const { res, headers } = fakeResponse();
    neutralizeStaticSharedCache(res);

    res.setHeaders(new Headers({ "Cache-Control": "s-maxage=31536000" }));

    expect(headers["cache-control"]).toBe(PUBLIC_PRERENDER_CACHE_CONTROL);
  });

  it("rewrites Cache-Control in a Map batch with a non-lowercase key", () => {
    const { res, headers } = fakeResponse();
    neutralizeStaticSharedCache(res);

    res.setHeaders(new Map([["Cache-Control", "s-maxage=31536000"]]));

    expect(headers["cache-control"]).toBe(PUBLIC_PRERENDER_CACHE_CONTROL);
  });
});

describe("neutralizeStaticSharedCache — writeHead", () => {
  it("rewrites Cache-Control in a headers object", () => {
    const { res } = fakeResponse();
    let seen: Record<string, unknown> | undefined;
    (res as unknown as { writeHead: (s: number, h: Record<string, unknown>) => void }).writeHead = (
      _s,
      h
    ) => {
      seen = h;
    };
    neutralizeStaticSharedCache(res);

    res.writeHead(200, {
      "Cache-Control": "s-maxage=31536000",
      "Content-Type": "text/x-component",
    });

    expect(seen?.["Cache-Control"]).toBe(PUBLIC_PRERENDER_CACHE_CONTROL);
    expect(seen?.["Content-Type"]).toBe("text/x-component");
  });

  it("rewrites Cache-Control with the (status, statusMessage, headers) overload", () => {
    const { res } = fakeResponse();
    let seen: Record<string, unknown> | undefined;
    (
      res as unknown as {
        writeHead: (s: number, m: string, h: Record<string, unknown>) => void;
      }
    ).writeHead = (_s, _m, h) => {
      seen = h;
    };
    neutralizeStaticSharedCache(res);

    res.writeHead(200, "OK", { "cache-control": "s-maxage=31536000" });

    expect(seen?.["cache-control"]).toBe(PUBLIC_PRERENDER_CACHE_CONTROL);
  });

  it("rewrites Cache-Control in a raw header array", () => {
    const { res } = fakeResponse();
    let seen: unknown[] | undefined;
    (res as unknown as { writeHead: (s: number, h: unknown[]) => void }).writeHead = (_s, h) => {
      seen = h;
    };
    neutralizeStaticSharedCache(res);

    res.writeHead(200, ["Content-Type", "text/html", "Cache-Control", "s-maxage=31536000"]);

    expect(seen).toEqual([
      "Content-Type",
      "text/html",
      "Cache-Control",
      PUBLIC_PRERENDER_CACHE_CONTROL,
    ]);
  });
});
