/**
 * Unit tests for OAuth redirect URI validation.
 *
 * RFC 8252 §7.3: the authorization server MUST allow any port for loopback
 * redirect URIs, since native clients (e.g. Claude Code) bind an ephemeral
 * port at authorization time. Non-loopback URIs use exact string matching
 * per OAuth 2.1.
 */

import { describe, it, expect } from "vitest";
import { validateRedirectUri, isValidRedirectUriFormat } from "../../src/server/oauth/utils";

describe("validateRedirectUri", () => {
  it("matches exact URIs", () => {
    expect(validateRedirectUri("https://app.example.com/cb", ["https://app.example.com/cb"])).toBe(
      true
    );
  });

  it("rejects non-loopback URIs that differ in any way", () => {
    expect(validateRedirectUri("https://app.example.com/cb2", ["https://app.example.com/cb"])).toBe(
      false
    );
    expect(
      validateRedirectUri("https://app.example.com:8443/cb", ["https://app.example.com/cb"])
    ).toBe(false);
  });

  it("allows any port for localhost when registered URI is portless (Claude Code CIMD)", () => {
    const registered = ["http://localhost/callback", "http://127.0.0.1/callback"];
    expect(validateRedirectUri("http://localhost:62336/callback", registered)).toBe(true);
    expect(validateRedirectUri("http://127.0.0.1:50000/callback", registered)).toBe(true);
  });

  it("allows a different port when registered URI has a port", () => {
    expect(
      validateRedirectUri("http://localhost:9999/callback", ["http://localhost:8080/callback"])
    ).toBe(true);
  });

  it("allows any port for [::1] loopback", () => {
    expect(validateRedirectUri("http://[::1]:62336/callback", ["http://[::1]/callback"])).toBe(
      true
    );
  });

  it("requires exact path match for loopback URIs", () => {
    expect(validateRedirectUri("http://localhost:62336/other", ["http://localhost/callback"])).toBe(
      false
    );
  });

  it("requires the same loopback hostname", () => {
    expect(
      validateRedirectUri("http://127.0.0.1:62336/callback", ["http://localhost/callback"])
    ).toBe(false);
  });

  it("requires the same scheme for loopback URIs", () => {
    expect(
      validateRedirectUri("https://localhost:62336/callback", ["http://localhost/callback"])
    ).toBe(false);
  });

  it("does not allow loopback matching against non-loopback registered URIs", () => {
    expect(
      validateRedirectUri("http://localhost:62336/callback", ["https://app.example.com/callback"])
    ).toBe(false);
  });

  it("does not treat localhost subdomains as loopback", () => {
    expect(
      validateRedirectUri("http://evil.localhost:62336/callback", ["http://localhost/callback"])
    ).toBe(false);
    expect(
      validateRedirectUri("http://localhost.evil.com:62336/callback", ["http://localhost/callback"])
    ).toBe(false);
  });

  it("requires exact query match for loopback URIs", () => {
    expect(
      validateRedirectUri("http://localhost:62336/callback?x=1", ["http://localhost/callback"])
    ).toBe(false);
    expect(
      validateRedirectUri("http://localhost:62336/callback?x=1", ["http://localhost/callback?x=1"])
    ).toBe(true);
  });

  it("rejects malformed requested URIs", () => {
    expect(validateRedirectUri("not-a-url", ["http://localhost/callback"])).toBe(false);
  });
});

describe("isValidRedirectUriFormat", () => {
  it("allows HTTPS URIs", () => {
    expect(isValidRedirectUriFormat("https://app.example.com/cb")).toBe(true);
  });

  it("allows HTTP for loopback hosts", () => {
    expect(isValidRedirectUriFormat("http://localhost:62336/callback")).toBe(true);
    expect(isValidRedirectUriFormat("http://127.0.0.1:62336/callback")).toBe(true);
    expect(isValidRedirectUriFormat("http://[::1]:62336/callback")).toBe(true);
  });

  it("rejects HTTP for non-loopback hosts", () => {
    expect(isValidRedirectUriFormat("http://app.example.com/cb")).toBe(false);
  });

  it("rejects URIs with fragments", () => {
    expect(isValidRedirectUriFormat("https://app.example.com/cb#frag")).toBe(false);
  });

  it("rejects malformed URIs", () => {
    expect(isValidRedirectUriFormat("not-a-url")).toBe(false);
  });
});
