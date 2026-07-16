/**
 * Unit tests for the manual redirect-following loop (`followRedirects`).
 *
 * `followRedirects` is the security-critical core of `fetchWithSsrfProtection`: it
 * drives the underlying fetch with `redirect: "manual"` and re-runs the per-hop
 * validator on every redirect target, closing the SSRF bypass where undici would
 * follow a redirect to an IP literal (e.g. http://169.254.169.254/) without running
 * its custom DNS lookup (issue #1077).
 *
 * The loop takes the fetch implementation and the per-hop validator as parameters,
 * so these tests exercise the *real* validator (`assertNotPrivateIpLiteral`) and the
 * real loop logic (method downgrade, credential stripping, max-redirects) against an
 * injected in-memory fetch — no live server, no mocked internal logic.
 */

import { describe, it, expect } from "vitest";
import {
  followRedirects,
  assertNotPrivateIpLiteral,
  assertAllowedScheme,
  assertAllowedUrl,
  type FetchImpl,
} from "../../src/server/http/ssrf";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/**
 * Builds a fake fetch from a map of URL -> response spec. Records every request so
 * tests can assert what each hop actually sent (method, headers after stripping).
 */
function fakeFetch(routes: Record<string, { status: number; location?: string }>) {
  const requests: RecordedRequest[] = [];
  const impl: FetchImpl = (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    requests.push({
      url,
      method,
      headers: new Headers(init.headers as HeadersInit | undefined),
      body: init.body,
    });
    const route = routes[url] ?? { status: 200 };
    const headers = new Headers();
    if (route.location) {
      headers.set("location", route.location);
    }
    // Body echoes the method so downgrade behavior is observable.
    const body = route.status === 200 ? `BODY:${method}` : null;
    return Promise.resolve(new Response(body, { status: route.status, headers }));
  };
  return { impl, requests };
}

describe("followRedirects — per-hop SSRF validation", () => {
  it("blocks a redirect chain ending at the cloud-metadata IP literal", async () => {
    const { impl } = fakeFetch({
      "http://public.example.com/a": { status: 302, location: "http://169.254.169.254/latest/" },
    });
    await expect(
      followRedirects("http://public.example.com/a", {}, impl, assertNotPrivateIpLiteral)
    ).rejects.toMatchObject({ name: "SsrfBlockedError" });
  });

  it("blocks a redirect to an IPv4-mapped IPv6 private literal", async () => {
    const { impl } = fakeFetch({
      "http://public.example.com/a": { status: 302, location: "http://[::ffff:169.254.169.254]/" },
    });
    await expect(
      followRedirects("http://public.example.com/a", {}, impl, assertNotPrivateIpLiteral)
    ).rejects.toMatchObject({ name: "SsrfBlockedError" });
  });

  it("blocks a redirect to a decimal-encoded private literal", async () => {
    // WHATWG URL normalizes http://2130706433/ to http://127.0.0.1/.
    const { impl } = fakeFetch({
      "http://public.example.com/a": { status: 302, location: "http://2130706433/" },
    });
    await expect(
      followRedirects("http://public.example.com/a", {}, impl, assertNotPrivateIpLiteral)
    ).rejects.toMatchObject({ name: "SsrfBlockedError" });
  });

  it("blocks a redirect that smuggles a private host in userinfo", async () => {
    // http://trusted@169.254.169.254/ — the host is 169.254.169.254.
    const { impl } = fakeFetch({
      "http://public.example.com/a": {
        status: 302,
        location: "http://trusted@169.254.169.254/",
      },
    });
    await expect(
      followRedirects("http://public.example.com/a", {}, impl, assertNotPrivateIpLiteral)
    ).rejects.toMatchObject({ name: "SsrfBlockedError" });
  });

  it("allows a redirect chain that stays on public hosts", async () => {
    const { impl, requests } = fakeFetch({
      "http://a.example.com/1": { status: 302, location: "http://b.example.com/2" },
      "http://b.example.com/2": { status: 200 },
    });
    const res = await followRedirects(
      "http://a.example.com/1",
      {},
      impl,
      assertNotPrivateIpLiteral
    );
    expect(res.status).toBe(200);
    expect(requests.map((r) => r.url)).toEqual([
      "http://a.example.com/1",
      "http://b.example.com/2",
    ]);
  });
});

describe("assertAllowedScheme — non-http(s) scheme rejection", () => {
  it("allows http and https URLs", () => {
    expect(() => assertAllowedScheme("http://public.example.com/a")).not.toThrow();
    expect(() => assertAllowedScheme("https://public.example.com/a")).not.toThrow();
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://example.com/",
    "data:text/plain,hi",
  ])("rejects non-http(s) scheme: %s", (url) => {
    expect(() => assertAllowedScheme(url)).toThrowError(
      expect.objectContaining({ name: "SsrfBlockedError" })
    );
  });

  it("rejects an unparseable URL (fail closed)", () => {
    expect(() => assertAllowedScheme("not a url")).toThrowError(
      expect.objectContaining({ name: "SsrfBlockedError" })
    );
  });
});

describe("followRedirects — per-hop scheme validation", () => {
  it("blocks an initial non-http(s) URL (dispatcher path validator)", async () => {
    const { impl, requests } = fakeFetch({});
    await expect(
      followRedirects("file:///etc/passwd", {}, impl, assertAllowedUrl)
    ).rejects.toMatchObject({ name: "SsrfBlockedError" });
    // Rejected before ever hitting the fetch impl.
    expect(requests).toHaveLength(0);
  });

  it("blocks an initial non-http(s) URL (allow-private path validator)", async () => {
    const { impl, requests } = fakeFetch({});
    await expect(
      followRedirects("file:///etc/passwd", {}, impl, assertAllowedScheme)
    ).rejects.toMatchObject({ name: "SsrfBlockedError" });
    expect(requests).toHaveLength(0);
  });

  it("blocks a redirect to a non-http(s) scheme (dispatcher path validator)", async () => {
    const { impl } = fakeFetch({
      "http://public.example.com/a": { status: 302, location: "file:///etc/passwd" },
    });
    await expect(
      followRedirects("http://public.example.com/a", {}, impl, assertAllowedUrl)
    ).rejects.toMatchObject({ name: "SsrfBlockedError" });
  });

  it("blocks a redirect to a non-http(s) scheme (allow-private path validator)", async () => {
    const { impl } = fakeFetch({
      "http://public.example.com/a": { status: 302, location: "gopher://public.example.com/" },
    });
    await expect(
      followRedirects("http://public.example.com/a", {}, impl, assertAllowedScheme)
    ).rejects.toMatchObject({ name: "SsrfBlockedError" });
  });
});

describe("followRedirects — credential stripping (regression for header leak)", () => {
  const noValidate = () => {};

  it("strips Authorization/Cookie on a cross-origin redirect", async () => {
    const { impl, requests } = fakeFetch({
      "http://a.example.com/1": { status: 302, location: "http://evil.example.net/2" },
      "http://evil.example.net/2": { status: 200 },
    });
    await followRedirects(
      "http://a.example.com/1",
      { headers: { Authorization: "Bearer SECRET", Cookie: "sid=1", "X-Keep": "yes" } },
      impl,
      noValidate
    );
    const secondHop = requests[1];
    expect(secondHop.headers.get("authorization")).toBeNull();
    expect(secondHop.headers.get("cookie")).toBeNull();
    // Non-credential headers are preserved across the redirect.
    expect(secondHop.headers.get("x-keep")).toBe("yes");
  });

  it("preserves Authorization on a same-origin redirect", async () => {
    const { impl, requests } = fakeFetch({
      "http://a.example.com/1": { status: 302, location: "http://a.example.com/2" },
      "http://a.example.com/2": { status: 200 },
    });
    await followRedirects(
      "http://a.example.com/1",
      { headers: { Authorization: "Bearer SECRET" } },
      impl,
      noValidate
    );
    expect(requests[1].headers.get("authorization")).toBe("Bearer SECRET");
  });

  it("treats a different port as cross-origin and strips credentials", async () => {
    const { impl, requests } = fakeFetch({
      "http://a.example.com/1": { status: 302, location: "http://a.example.com:8080/2" },
      "http://a.example.com:8080/2": { status: 200 },
    });
    await followRedirects(
      "http://a.example.com/1",
      { headers: { Authorization: "Bearer SECRET" } },
      impl,
      noValidate
    );
    expect(requests[1].headers.get("authorization")).toBeNull();
  });
});

describe("followRedirects — method/body downgrade", () => {
  const noValidate = () => {};

  it("downgrades POST to GET and drops the body + content headers on 302", async () => {
    const { impl, requests } = fakeFetch({
      "http://a.example.com/post": { status: 302, location: "http://a.example.com/final" },
      "http://a.example.com/final": { status: 200 },
    });
    const res = await followRedirects(
      "http://a.example.com/post",
      {
        method: "POST",
        body: "payload",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
      impl,
      noValidate
    );
    expect(await res.text()).toBe("BODY:GET");
    const finalHop = requests[1];
    expect(finalHop.method).toBe("GET");
    expect(finalHop.body).toBeUndefined();
    expect(finalHop.headers.get("content-type")).toBeNull();
  });

  it("preserves method and body on a 307 redirect", async () => {
    const { impl, requests } = fakeFetch({
      "http://a.example.com/post": { status: 307, location: "http://a.example.com/final" },
      "http://a.example.com/final": { status: 200 },
    });
    const res = await followRedirects(
      "http://a.example.com/post",
      { method: "POST", body: "payload" },
      impl,
      noValidate
    );
    expect(await res.text()).toBe("BODY:POST");
    expect(requests[1].method).toBe("POST");
    expect(requests[1].body).toBe("payload");
  });
});

describe("followRedirects — control flow", () => {
  const noValidate = () => {};

  it("returns the redirect unfollowed when redirect: manual", async () => {
    const { impl, requests } = fakeFetch({
      "http://a.example.com/1": { status: 301, location: "http://a.example.com/2" },
    });
    const res = await followRedirects(
      "http://a.example.com/1",
      { redirect: "manual" },
      impl,
      noValidate
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("http://a.example.com/2");
    expect(requests).toHaveLength(1);
  });

  it("throws on the first redirect when redirect: error", async () => {
    const { impl } = fakeFetch({
      "http://a.example.com/1": { status: 302, location: "http://a.example.com/2" },
    });
    await expect(
      followRedirects("http://a.example.com/1", { redirect: "error" }, impl, noValidate)
    ).rejects.toThrow(/unexpected redirect/i);
  });

  it("returns the response when a redirect status has no Location header", async () => {
    const { impl } = fakeFetch({
      "http://a.example.com/1": { status: 302 },
    });
    const res = await followRedirects("http://a.example.com/1", {}, impl, noValidate);
    expect(res.status).toBe(302);
  });

  it("throws after exceeding the max redirect count", async () => {
    const { impl } = fakeFetch({
      // Self-redirect forever.
      "http://a.example.com/loop": { status: 302, location: "http://a.example.com/loop" },
    });
    await expect(
      followRedirects("http://a.example.com/loop", {}, impl, noValidate)
    ).rejects.toThrow(/too many redirects/i);
  });
});
