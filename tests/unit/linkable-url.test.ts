import { describe, expect, it } from "vitest";

import { linkableUrl } from "../../src/server/http/linkable-url";

describe("linkableUrl", () => {
  it.each([
    "javascript:alert(1)",
    " JAVASCRIPT:alert(1)",
    "\tjava\nscript:alert(1)",
    "\u0000javascript:alert(1)",
    "data:text/html,x",
    // The parser keeps a `"` in the host.
    'http://a"b.example/',
    "/relative",
    "//host/x",
    "",
  ])("rejects %j", (url) => {
    expect(linkableUrl(url)).toBeNull();
  });

  // Clients get exactly what was checked, so no parser of theirs can read it
  // differently, and no unencoded `"` reaches one that splices it into HTML.
  it.each([
    ["HTTPS://E.COM/a", "https://e.com/a"],
    ["https://bücher.de/x", "https://xn--bcher-kva.de/x"],
    ["http://e.com:8080/a", "http://e.com:8080/a"],
    [" https://e.com/a\n", "https://e.com/a"],
    ["\u0001https://ok.example/", "https://ok.example/"],
    ["ht\ttps://e.com", "https://e.com/"],
    ["http:evil.example", "http://evil.example/"],
    ['https://ok.example/"><script>', "https://ok.example/%22%3E%3Cscript%3E"],
  ])("normalizes %j", (url, expected) => {
    expect(linkableUrl(url)).toBe(expected);
  });
});
