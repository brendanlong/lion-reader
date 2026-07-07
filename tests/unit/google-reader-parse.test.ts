/**
 * Unit tests for Google Reader request parsing.
 *
 * Clients disagree on where to put parameters: FocusReader/newsboat send them in
 * the form body, while FeedMe sends them in the URL query string even on a POST
 * (`POST /accounts/ClientLogin?Email=…&Passwd=…` with an empty body). The
 * original Google Reader API and FreshRSS accept either (PHP `$_REQUEST`), so
 * parseFormData merges query + body with the body winning on conflicts.
 */

import { describe, it, expect } from "vitest";
import { parseFormData, parseItemIds } from "../../src/server/google-reader/parse";

function postRequest(url: string, body?: string, contentType?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : undefined,
    body,
  });
}

const FORM = "application/x-www-form-urlencoded";

describe("parseFormData", () => {
  it("reads params from the URL query string on a POST (FeedMe-style, empty body)", async () => {
    const req = postRequest("https://x.test/accounts/ClientLogin?Email=a%40b.com&Passwd=secret");
    const params = await parseFormData(req);
    expect(params.get("Email")).toBe("a@b.com");
    expect(params.get("Passwd")).toBe("secret");
  });

  it("reads params from a url-encoded body (FocusReader-style)", async () => {
    const req = postRequest(
      "https://x.test/accounts/ClientLogin",
      "Email=a%40b.com&Passwd=secret",
      FORM
    );
    const params = await parseFormData(req);
    expect(params.get("Email")).toBe("a@b.com");
    expect(params.get("Passwd")).toBe("secret");
  });

  it("lets the body win over the query string on conflicting keys", async () => {
    const req = postRequest(
      "https://x.test/accounts/ClientLogin?Passwd=fromQuery",
      "Passwd=fromBody",
      FORM
    );
    const params = await parseFormData(req);
    expect(params.get("Passwd")).toBe("fromBody");
    // Exactly one value — we don't accumulate both sides.
    expect(params.getAll("Passwd")).toEqual(["fromBody"]);
  });

  it("keeps a query param the body does not override", async () => {
    const req = postRequest("https://x.test/reader/api/0/edit-tag?T=token", "i=123&a=read", FORM);
    const params = await parseFormData(req);
    expect(params.get("T")).toBe("token");
    expect(params.get("i")).toBe("123");
    expect(params.get("a")).toBe("read");
  });

  it("returns query params for a GET", async () => {
    const req = new Request("https://x.test/reader/api/0/stream/items/ids?s=reading-list&n=5");
    const params = await parseFormData(req);
    expect(params.get("s")).toBe("reading-list");
    expect(params.get("n")).toBe("5");
  });

  it("parses multipart body params", async () => {
    const form = new FormData();
    form.set("Email", "a@b.com");
    form.set("Passwd", "secret");
    const req = new Request("https://x.test/accounts/ClientLogin", { method: "POST", body: form });
    const params = await parseFormData(req);
    expect(params.get("Email")).toBe("a@b.com");
    expect(params.get("Passwd")).toBe("secret");
  });

  it("merges repeated item IDs, preferring the body's set when present", async () => {
    // Body carries the `i` list (the normal contents transport); a stray query
    // `i` must not leak in alongside it.
    const req = postRequest(
      "https://x.test/reader/api/0/stream/items/contents?i=999",
      "i=1&i=2&i=3",
      FORM
    );
    const params = await parseFormData(req);
    expect(parseItemIds(params)).toEqual([BigInt(1), BigInt(2), BigInt(3)]);
  });
});
