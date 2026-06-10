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
 * would leave open. It applies to redirects too, since fetch reuses the dispatcher.
 */

import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { Agent, type Dispatcher } from "undici";

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
 * Wraps fetch init options with SSRF protection. Pass the result straight to `fetch`.
 *
 * Two layers of protection:
 * 1. Literal IP hosts (e.g. http://169.254.169.254/) are checked synchronously and
 *    rejected here — undici bypasses the custom DNS lookup for IP literals.
 * 2. Hostnames are validated at connection time by the attached undici dispatcher,
 *    which resolves DNS and connects only to a vetted address (rebinding-safe).
 *
 * @throws SsrfBlockedError if the URL targets a literal private/internal IP
 * @example
 * const res = await fetch(url, withSsrfProtection(url, { headers, signal }));
 */
export function withSsrfProtection<T extends RequestInit>(
  url: string,
  init: T
): T & { dispatcher?: Dispatcher } {
  const dispatcher = getSsrfDispatcher();

  // Private-network fetching explicitly allowed (dev/test): no protection.
  if (!dispatcher) {
    return init;
  }

  // Literal IP hosts skip the dispatcher's DNS lookup, so check them here.
  const hostname = getHostname(url);
  if (hostname && isIP(hostname) !== 0 && isPrivateAddress(hostname)) {
    throw new SsrfBlockedError(hostname, hostname);
  }

  return { ...init, dispatcher };
}
