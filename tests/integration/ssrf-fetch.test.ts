/**
 * Integration tests for the SSRF-protected fetch wiring (`fetchWithSsrfProtection`).
 *
 * The unit tests in `tests/unit/ssrf.test.ts` only cover the pure `isPrivateAddress`
 * range logic. They do NOT exercise the actual undici `Agent` + custom `connect.lookup`
 * + `fetch` plumbing — which is the part that can break across an undici major version
 * (e.g. the 7 -> 8 bump). These tests drive real HTTP requests against a loopback
 * server so that the wiring itself is covered:
 *
 * 1. The custom DNS lookup is actually invoked by undici's connector and aborts the
 *    connection for a hostname that resolves to a private address (DNS-rebinding guard).
 * 2. Literal private-IP hosts are rejected up front (undici skips the lookup for them).
 * 3. The documented decompression landmine: undici's `fetch` driven through a custom
 *    `Agent({ connect: { lookup } })` dispatcher must still decompress gzip/brotli
 *    response bodies. On Node 26, Node's *global* fetch silently skips decompression
 *    when handed a foreign dispatcher; `fetchWithSsrfProtection` avoids that by using the
 *    npm `undici` package's own `fetch`. This pins that behavior so an undici upgrade
 *    that reintroduces the corruption fails here instead of silently shipping garbage
 *    article bodies.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { Agent, fetch as undiciFetch } from "undici";

import { fetchWithSsrfProtection } from "../../src/server/http/ssrf";

const BODY = "the quick brown fox ".repeat(64); // big enough that encoding actually differs

// A loopback server that encodes its response according to the request path.
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/gzip") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
      res.end(gzipSync(BODY));
    } else if (url === "/br") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "br" });
      res.end(brotliCompressSync(BODY));
    } else if (url.startsWith("/redirect-301")) {
      res.writeHead(301, { Location: "/final" });
      res.end();
    } else if (url.startsWith("/redirect-302")) {
      res.writeHead(302, { Location: "/final" });
      res.end();
    } else if (url.startsWith("/redirect-loop")) {
      // Always redirects to itself — exercises the max-redirects guard.
      res.writeHead(302, { Location: "/redirect-loop" });
      res.end();
    } else if (url === "/final") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`FINAL:${req.method}`);
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(BODY);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
});

describe("fetchWithSsrfProtection — SSRF blocking", () => {
  const prev = process.env.ALLOW_PRIVATE_NETWORK_FETCH;

  // Force protection ON. `allowPrivateNetworkFetch` is a live getter on process.env,
  // so this takes effect per-call even though .env.test defaults it to "true".
  beforeAll(() => {
    process.env.ALLOW_PRIVATE_NETWORK_FETCH = "false";
  });
  afterAll(() => {
    if (prev === undefined) {
      delete process.env.ALLOW_PRIVATE_NETWORK_FETCH;
    } else {
      process.env.ALLOW_PRIVATE_NETWORK_FETCH = prev;
    }
  });

  it("rejects a literal private IP host up front (lookup is skipped for IP literals)", async () => {
    await expect(fetchWithSsrfProtection(`http://127.0.0.1:${port}/`, {})).rejects.toMatchObject({
      name: "SsrfBlockedError",
    });
  });

  it("rejects the cloud-metadata IP", async () => {
    await expect(
      fetchWithSsrfProtection("http://169.254.169.254/latest/meta-data/", {})
    ).rejects.toMatchObject({ name: "SsrfBlockedError" });
  });

  it("rejects an IPv4-mapped IPv6 literal for a private address", async () => {
    // http://[::ffff:169.254.169.254]/ — same metadata IP wrapped as IPv6.
    await expect(
      fetchWithSsrfProtection("http://[::ffff:169.254.169.254]/latest/meta-data/", {})
    ).rejects.toMatchObject({ name: "SsrfBlockedError" });
  });

  it("rejects an IPv4-mapped IPv6 literal in hex form", async () => {
    // ::ffff:a9fe:a9fe is 169.254.169.254 written with hex quads.
    await expect(fetchWithSsrfProtection("http://[::ffff:a9fe:a9fe]/", {})).rejects.toMatchObject({
      name: "SsrfBlockedError",
    });
  });

  it("rejects a decimal-encoded private IP", async () => {
    // 2130706433 == 127.0.0.1. WHATWG URL normalizes the decimal host to the
    // dotted literal 127.0.0.1, so the up-front literal check catches it directly.
    await expect(fetchWithSsrfProtection("http://2130706433/", {})).rejects.toMatchObject({
      name: "SsrfBlockedError",
    });
  });

  it("blocks a hostname that resolves to loopback at connection time", async () => {
    // `localhost` resolves to 127.0.0.1/::1; the custom lookup must abort the connect.
    // undici's fetch wraps the connect error as `TypeError: fetch failed` with the
    // original error on `.cause` (identical behavior under undici 7 and 8).
    await expect(fetchWithSsrfProtection(`http://localhost:${port}/`, {})).rejects.toMatchObject({
      cause: { name: "SsrfBlockedError" },
    });
  });
});

describe("fetchWithSsrfProtection — manual redirect following", () => {
  // The per-hop private-IP check is the same `assertNotPrivateIpLiteral` call at
  // hop 0 (covered by the SSRF-blocking tests above) and on every redirect target.
  // A true protection-ON multi-hop test can't use a loopback server — the initial
  // request to loopback is itself blocked — so these tests run with protection OFF
  // to exercise the redirect-following loop itself (following, method downgrade,
  // manual passthrough, and the max-redirects guard).
  const prev = process.env.ALLOW_PRIVATE_NETWORK_FETCH;

  beforeAll(() => {
    process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
  });
  afterAll(() => {
    if (prev === undefined) {
      delete process.env.ALLOW_PRIVATE_NETWORK_FETCH;
    } else {
      process.env.ALLOW_PRIVATE_NETWORK_FETCH = prev;
    }
  });

  it("follows a 302 redirect and returns the final response", async () => {
    const res = await fetchWithSsrfProtection(`http://127.0.0.1:${port}/redirect-302`, {});
    expect(res.status).toBe(200);
    expect(res.url).toBe(`http://127.0.0.1:${port}/final`);
    expect(await res.text()).toBe("FINAL:GET");
  });

  it("downgrades POST to GET on a 302 redirect (per the Fetch spec)", async () => {
    const res = await fetchWithSsrfProtection(`http://127.0.0.1:${port}/redirect-302`, {
      method: "POST",
      body: "hello",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("FINAL:GET");
  });

  it("returns the redirect unfollowed when redirect: manual", async () => {
    const res = await fetchWithSsrfProtection(`http://127.0.0.1:${port}/redirect-301`, {
      redirect: "manual",
    });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/final");
  });

  it("throws when a redirect loop exceeds the max hop count", async () => {
    await expect(
      fetchWithSsrfProtection(`http://127.0.0.1:${port}/redirect-loop`, {})
    ).rejects.toThrow(/too many redirects/i);
  });
});

describe("undici dispatcher decompression (regression guard for undici upgrades)", () => {
  // Reproduces the exact dispatcher construction from ssrf.ts, but with a permissive
  // lookup so the request reaches the loopback test server. This isolates the property
  // under test — "npm undici fetch + a custom connect.lookup dispatcher decompresses
  // response bodies" — which is what the Node-26 global-fetch landmine corrupted.
  let dispatcher: Agent;

  beforeAll(() => {
    dispatcher = new Agent({
      connect: {
        // Honor both lookup call styles (undici's connector uses `{ all: true }`),
        // matching the real ssrfLookup contract.
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [{ address: "127.0.0.1", family: 4 }]);
          } else {
            callback(null, "127.0.0.1", 4);
          }
        },
      },
    });
  });
  afterAll(async () => {
    await dispatcher.close();
  });

  it("decompresses a gzip-encoded body", async () => {
    const res = await undiciFetch(`http://localhost:${port}/gzip`, { dispatcher });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
  });

  it("decompresses a brotli-encoded body", async () => {
    const res = await undiciFetch(`http://localhost:${port}/br`, { dispatcher });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
  });
});
