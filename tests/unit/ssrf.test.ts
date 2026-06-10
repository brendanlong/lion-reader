/**
 * Unit tests for SSRF address classification.
 *
 * These verify which resolved IP addresses are blocked as private/internal.
 * The DNS-resolution + connection wiring is exercised by integration/e2e paths;
 * here we test the pure address-range logic that decides what gets blocked.
 */

import { describe, it, expect } from "vitest";
import { isPrivateAddress } from "../../src/server/http/ssrf";

describe("isPrivateAddress", () => {
  describe("blocks private/internal IPv4", () => {
    const blocked = [
      "127.0.0.1", // loopback
      "127.1.2.3", // loopback range
      "0.0.0.0", // "this" network
      "10.0.0.1", // RFC 1918
      "10.255.255.255",
      "172.16.0.1", // RFC 1918
      "172.31.255.255",
      "192.168.0.1", // RFC 1918
      "192.168.1.1",
      "169.254.169.254", // cloud metadata (link-local)
      "169.254.0.1",
      "100.64.0.1", // carrier-grade NAT
      "192.0.0.1", // IETF protocol assignments
      "192.0.2.1", // TEST-NET-1
      "198.18.0.1", // benchmarking
      "198.51.100.1", // TEST-NET-2
      "203.0.113.1", // TEST-NET-3
      "224.0.0.1", // multicast
      "240.0.0.1", // reserved
      "255.255.255.255", // broadcast
    ];

    for (const ip of blocked) {
      it(`blocks ${ip}`, () => {
        expect(isPrivateAddress(ip)).toBe(true);
      });
    }
  });

  describe("allows public IPv4", () => {
    const allowed = [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.216.34", // example.com
      "172.15.255.255", // just below 172.16/12
      "172.32.0.1", // just above 172.16/12
      "169.253.255.255", // just below link-local
      "11.0.0.1", // just above 10/8
      "100.63.255.255", // just below CGNAT
      "100.128.0.1", // just above CGNAT
    ];

    for (const ip of allowed) {
      it(`allows ${ip}`, () => {
        expect(isPrivateAddress(ip)).toBe(false);
      });
    }
  });

  describe("blocks private/internal IPv6", () => {
    const blocked = [
      "::1", // loopback
      "::", // unspecified
      "fc00::1", // unique local
      "fd12:3456:789a::1", // unique local
      "fe80::1", // link-local
      "ff02::1", // multicast
      "2001:db8::1", // documentation
      "64:ff9b::7f00:1", // NAT64 of 127.0.0.1
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "::ffff:169.254.169.254", // IPv4-mapped metadata
      "::ffff:10.0.0.1", // IPv4-mapped private
    ];

    for (const ip of blocked) {
      it(`blocks ${ip}`, () => {
        expect(isPrivateAddress(ip)).toBe(true);
      });
    }
  });

  describe("allows public IPv6", () => {
    const allowed = [
      "2606:4700:4700::1111", // Cloudflare DNS
      "2001:4860:4860::8888", // Google DNS
      "::ffff:8.8.8.8", // IPv4-mapped public
    ];

    for (const ip of allowed) {
      it(`allows ${ip}`, () => {
        expect(isPrivateAddress(ip)).toBe(false);
      });
    }
  });

  it("fails closed for non-IP input", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});
