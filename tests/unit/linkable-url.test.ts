import { describe, expect, it } from "vitest";

import { linkableUrl } from "../../src/server/http/linkable-url";

describe("linkableUrl", () => {
  it.each([
    "javascript:alert(1)",
    " JAVASCRIPT:alert(1)",
    "\tjava\nscript:alert(1)",
    "\u0000javascript:alert(1)",
    "data:text/html,x",
    "/relative",
    "//host/x",
    "",
  ])("rejects %j", (url) => {
    expect(linkableUrl(url)).toBeNull();
  });

  it.each([
    ["HTTPS://E.COM/a", "HTTPS://E.COM/a"],
    ["https://bücher.de/x", "https://bücher.de/x"],
    ["http://e.com:8080/a", "http://e.com:8080/a"],
    [" https://e.com/a\n", "https://e.com/a"],
  ])("keeps %j", (url, expected) => {
    expect(linkableUrl(url)).toBe(expected);
  });
});
