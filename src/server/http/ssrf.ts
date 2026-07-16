/**
 * SSRF Protection
 *
 * Blocks server-side requests to private/internal IP ranges (loopback, RFC 1918,
 * link-local cloud metadata, etc.) to prevent Server-Side Request Forgery via
 * user-supplied URLs (feed preview/discover, feed fetching, full-content fetching,
 * WebSub hub callbacks).
 *
 * Protection is enforced at DNS-resolution time via a custom undici dispatcher.
 * The custom `lookup` resolves the hostname, validates every returned address,
 * and connects only to the resolved IP — so the validated address is the one
 * actually used, closing the DNS-rebinding TOCTOU gap that a hostname-only check
 * would leave open.
 *
 * Redirects are re-validated per hop: undici skips the custom `lookup` for
 * IP-literal hosts, so a redirect to `http://169.254.169.254/` would otherwise
 * connect with no validation. `fetchWithSsrfProtection` therefore always fetches
 * with `redirect: "manual"` and follows redirects itself, running the literal-IP
 * check on every hop's URL before connecting. No caller can opt out of per-hop
 * validation.
 */

import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

import { securityConfig } from "../config/env";

/**
 * Private/reserved IPv4 ranges as [network, prefix] tuples. Each is also blocked in
 * its IPv4-mapped IPv6 form (::ffff:net/(96+prefix)) so attackers can't bypass the
 * block by encoding a private IPv4 as an IPv6 literal.
 */
const PRIVATE_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC 1918 private
  ["100.64.0.0", 10], // RFC 6598 carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["172.16.0.0", 12], // RFC 1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC 1918 private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved (incl. 255.255.255.255 broadcast)
];

/**
 * Reserved/private IP ranges that must never be reachable from server-side fetches.
 * Covers loopback, RFC 1918 private, carrier-grade NAT, link-local (incl. the
 * 169.254.169.254 cloud metadata endpoint), documentation/test, multicast, and
 * reserved space for both IPv4 and IPv6 — including IPv4-mapped and IPv4-compatible
 * IPv6 forms. BlockList matches numerically, so it catches alternative textual
 * encodings (hex, compressed) of the same address.
 */
function buildBlockList(): BlockList {
  const list = new BlockList();

  for (const [network, prefix] of PRIVATE_IPV4_RANGES) {
    list.addSubnet(network, prefix, "ipv4");
    // IPv4-mapped IPv6 (::ffff:a.b.c.d): the IPv4 /N maps to an IPv6 /(96+N).
    list.addSubnet(`::ffff:${network}`, 96 + prefix, "ipv6");
  }

  // ::/96 covers the unspecified address (::), IPv6 loopback (::1), and the
  // deprecated IPv4-compatible IPv6 range (::a.b.c.d) — none are valid public hosts.
  list.addSubnet("::", 96, "ipv6");
  list.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64 (can translate to private IPv4)
  list.addSubnet("100::", 64, "ipv6"); // discard-only
  list.addSubnet("2001:db8::", 32, "ipv6"); // documentation
  list.addSubnet("fc00::", 7, "ipv6"); // unique local
  list.addSubnet("fe80::", 10, "ipv6"); // link-local
  list.addSubnet("ff00::", 8, "ipv6"); // multicast

  return list;
}

const blockList = buildBlockList();

/**
 * Returns true if the given IP address is in a private/reserved range.
 *
 * Only valid IP literals are expected (post-DNS-resolution). Anything that isn't
 * a parseable IP is treated as private (blocked) to fail closed. IPv4-mapped and
 * IPv4-compatible IPv6 forms are covered by the block list itself, so no special
 * unwrapping is needed.
 */
export function isPrivateAddress(address: string): boolean {
  const type = isIP(address);
  if (type === 0) {
    // Not a valid IP literal — block to fail closed.
    return true;
  }
  return blockList.check(address, type === 6 ? "ipv6" : "ipv4");
}

/**
 * Error thrown when a request targets a blocked (private/internal) address.
 */
class SsrfBlockedError extends Error {
  constructor(
    public readonly hostname: string,
    public readonly address: string
  ) {
    super(`Blocked request to private address ${address} (resolved from ${hostname})`);
    this.name = "SsrfBlockedError";
  }
}

/**
 * Error thrown when a request targets a URL whose scheme is not http(s).
 *
 * Shares the `SsrfBlockedError` name so callers/error handlers that classify
 * SSRF rejections by `err.name` treat a blocked scheme the same as a blocked
 * address.
 */
class SsrfBlockedSchemeError extends Error {
  constructor(
    public readonly url: string,
    public readonly scheme: string
  ) {
    super(`Blocked request to non-http(s) scheme "${scheme}" (${url})`);
    this.name = "SsrfBlockedError";
  }
}

/**
 * Schemes the SSRF guard permits. Everything else (file:, ftp:, gopher:, data:,
 * etc.) is rejected up front so the guarantee holds regardless of what the
 * underlying fetch implementation happens to accept.
 */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Rejects any URL whose scheme is not http(s), fail-closed.
 *
 * SECURITY.md §2 promises the guard "rejects non-http schemes". The IP-range and
 * DNS-pinning checks assume an http(s) host, and today non-http schemes are only
 * rejected *implicitly* by the underlying `fetch`. Enforcing an explicit allowlist
 * here — on the initial URL and every redirect hop — makes that guarantee real and
 * independent of the fetch transport. An unparseable URL is treated as disallowed.
 *
 * @throws SsrfBlockedError if the URL's scheme is not http: or https:
 */
export function assertAllowedScheme(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    // Unparseable URL — fail closed rather than hand it to the fetch impl.
    throw new SsrfBlockedSchemeError(url, "unparseable");
  }
  if (!ALLOWED_PROTOCOLS.has(protocol)) {
    throw new SsrfBlockedSchemeError(url, protocol);
  }
}

/**
 * Custom DNS lookup that validates every resolved address against the block list.
 *
 * Follows the Node `dns.lookup` callback contract for both the single-address and
 * `{ all: true }` call styles so it can be used transparently by undici's connector.
 */
function ssrfLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number
  ) => void
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, []);
      return;
    }

    if (!addresses || addresses.length === 0) {
      callback(new SsrfBlockedError(hostname, "unresolved"), []);
      return;
    }

    for (const { address } of addresses) {
      if (isPrivateAddress(address)) {
        callback(new SsrfBlockedError(hostname, address), []);
        return;
      }
    }

    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  });
}

let cachedDispatcher: Agent | undefined;

/**
 * Returns the SSRF-protecting undici dispatcher, or undefined when private-network
 * fetching is explicitly allowed (dev/test via ALLOW_PRIVATE_NETWORK_FETCH=true),
 * in which case the global dispatcher is used.
 */
function getSsrfDispatcher(): Agent | undefined {
  if (securityConfig.allowPrivateNetworkFetch) {
    return undefined;
  }
  if (!cachedDispatcher) {
    cachedDispatcher = new Agent({ connect: { lookup: ssrfLookup } });
  }
  return cachedDispatcher;
}

/**
 * Returns the hostname of a URL with IPv6 brackets stripped, or null if it can't
 * be parsed.
 */
function getHostname(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    // WHATWG URL wraps IPv6 literals in brackets, e.g. "[::1]".
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      return hostname.slice(1, -1);
    }
    return hostname;
  } catch {
    return null;
  }
}

/**
 * Rejects a URL whose host is a literal private/internal IP.
 *
 * undici bypasses the custom DNS lookup for IP literals (it calls `net.connect`
 * directly), so literal hosts must be checked here — both for the initial URL and
 * for every redirect hop.
 *
 * @throws SsrfBlockedError if the URL's host is a literal private/internal IP
 */
export function assertNotPrivateIpLiteral(url: string): void {
  const hostname = getHostname(url);
  if (hostname && isIP(hostname) !== 0 && isPrivateAddress(hostname)) {
    throw new SsrfBlockedError(hostname, hostname);
  }
}

/**
 * Full per-hop validator for the DNS-pinning path: rejects non-http(s) schemes and
 * literal private/internal IP hosts. Runs on the initial URL and every redirect hop.
 */
export function assertAllowedUrl(url: string): void {
  assertAllowedScheme(url);
  assertNotPrivateIpLiteral(url);
}

/**
 * Maximum redirects to follow before giving up. Matches undici/browser defaults.
 */
const MAX_REDIRECTS = 20;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Request headers that carry credentials and must be stripped when a redirect
 * crosses origins, matching the Fetch spec's "HTTP redirect fetch" (which is what
 * undici's native redirect handling does — the manual loop must replicate it, or
 * following a cross-origin redirect would leak, e.g., a Google OAuth `Authorization`
 * bearer token to the redirect target).
 */
const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * Request headers describing a body, dropped alongside the body when a redirect
 * downgrades the method to GET (301/302 on a POST, or any 303). Per the Fetch spec.
 */
const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
  "content-length",
];

/**
 * A fetch implementation the redirect loop drives. Always called with
 * `redirect: "manual"` so the loop can inspect and re-validate each hop itself.
 */
export type FetchImpl = (url: string, init: UndiciRequestInit) => Promise<Response>;

function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * Follows redirects manually, re-validating every hop. Pure aside from the injected
 * `fetchImpl` and `validateHop`, so the per-hop SSRF check, credential stripping,
 * and method-downgrade behavior can be unit-tested without a live server.
 *
 * `validateHop` runs on the initial URL and on every redirect target *before*
 * connecting — this is where the scheme allowlist and literal-IP check live,
 * closing the bypass where undici follows a redirect to an IP literal (e.g.
 * `http://169.254.169.254/`) without running its custom DNS lookup, and rejecting
 * non-http(s) schemes regardless of what the fetch impl would accept.
 */
export async function followRedirects(
  url: string,
  init: RequestInit,
  fetchImpl: FetchImpl,
  validateHop: (url: string) => void
): Promise<Response> {
  const redirectMode = init.redirect ?? "follow";

  let currentUrl = url;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  // Mutable copy so we can strip credentials/body headers across hops without
  // mutating the caller's object.
  const headers = new Headers(init.headers as HeadersInit | undefined);

  for (let hop = 0; ; hop++) {
    validateHop(currentUrl);

    const response = await fetchImpl(currentUrl, {
      ...(init as UndiciRequestInit),
      method,
      body: body as UndiciRequestInit["body"],
      headers,
      // Always follow redirects ourselves so each hop is re-validated above.
      redirect: "manual",
    });

    // Caller handles redirects itself (e.g. the feed fetcher): return unfollowed.
    if (redirectMode === "manual") {
      return response;
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    // A redirect status without a usable Location is not followable; hand it back.
    if (!location) {
      return response;
    }

    if (redirectMode === "error") {
      throw new Error(`Unexpected redirect (${response.status}) fetching ${currentUrl}`);
    }

    if (hop >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects fetching ${url}`);
    }

    // Free the intermediate connection before issuing the next request.
    await response.body?.cancel().catch(() => {});

    const nextUrl = new URL(location, currentUrl).toString();

    // Strip credential headers when the redirect crosses origins (scheme/host/port).
    if (originOf(nextUrl) !== originOf(currentUrl)) {
      for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) {
        headers.delete(name);
      }
    }

    // Per the Fetch spec, 301/302 on a POST and any 303 downgrade to GET and drop
    // the body (and its describing headers); 307/308 preserve method and body.
    if (
      ((response.status === 301 || response.status === 302) && method === "POST") ||
      (response.status === 303 && method !== "GET" && method !== "HEAD")
    ) {
      method = "GET";
      body = undefined;
      for (const name of BODY_HEADERS) {
        headers.delete(name);
      }
    }

    currentUrl = nextUrl;
  }
}

/**
 * Performs a fetch with SSRF protection. Use this instead of `fetch` for any
 * request whose URL is user-influenced.
 *
 * Layers of protection, applied to the initial request and every redirect hop:
 * 0. Non-http(s) schemes (file:, ftp:, gopher:, data:, …) are rejected up front by
 *    an explicit allowlist, in both the protected and ALLOW_PRIVATE_NETWORK_FETCH
 *    paths, so the guarantee doesn't depend on the underlying fetch implementation.
 * 1. Literal IP hosts (e.g. http://169.254.169.254/) are checked up front and
 *    rejected here — undici bypasses the custom DNS lookup for IP literals.
 * 2. Hostnames are validated at connection time by the attached undici dispatcher,
 *    which resolves DNS and connects only to a vetted address (rebinding-safe).
 *
 * Redirects are followed manually by {@link followRedirects} (the underlying fetch
 * is always driven with `redirect: "manual"`) so each hop is re-validated. Following
 * redirects inside undici would skip the literal-IP check for a redirect target like
 * `http://169.254.169.254/`, since undici only runs the custom lookup for hostnames.
 * Credential headers (`Authorization`/`Cookie`) are stripped on cross-origin hops,
 * matching undici's native redirect handling. Callers that request `redirect:
 * "manual"` get the first response back unfollowed (e.g. the feed fetcher, which
 * tracks permanent redirects itself and re-enters this helper per hop);
 * `redirect: "error"` throws on the first redirect.
 *
 * When protection is enabled the request goes through the npm `undici` package's
 * fetch, not Node's global fetch. The dispatcher is constructed from the npm
 * package, and Node's global fetch is a different (bundled) undici copy: on Node 26
 * it accepts the foreign dispatcher but skips response body decompression,
 * returning raw gzip/brotli bytes. The dispatcher and the fetch that uses it must
 * come from the same copy. When private-network fetching is explicitly allowed
 * (dev/test), the literal/DNS checks are skipped and Node's global fetch is used,
 * but redirects are still followed by the same loop.
 *
 * @throws SsrfBlockedError if the URL (or any redirect hop) uses a non-http(s)
 *   scheme or targets a literal private/internal IP
 * @example
 * const res = await fetchWithSsrfProtection(url, { headers, signal });
 */
export async function fetchWithSsrfProtection(url: string, init: RequestInit): Promise<Response> {
  const dispatcher = getSsrfDispatcher();

  // When private-network fetching is allowed (dev/test) there is no dispatcher, so
  // we skip the SSRF checks and use Node's global fetch. The redirect-following
  // loop runs in both modes so its behavior is identical (and testable) either way.
  if (dispatcher) {
    return followRedirects(
      url,
      init,
      // undici's Response is the same spec-compliant implementation as the global
      // one; cast so callers keep using standard Response types.
      (hopUrl, hopInit) =>
        undiciFetch(hopUrl, { ...hopInit, dispatcher }) as unknown as Promise<Response>,
      assertAllowedUrl
    );
  }

  // Private-network fetching is allowed (dev/test), so the literal/DNS checks are
  // skipped — but the scheme allowlist is not: a non-http(s) scheme is rejected in
  // both modes so the guarantee is independent of the underlying fetch.
  return followRedirects(
    url,
    init,
    (hopUrl, hopInit) => fetch(hopUrl, hopInit as RequestInit),
    assertAllowedScheme
  );
}
