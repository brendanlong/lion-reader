/**
 * Unit tests for email header parsing utilities.
 */

import { describe, it, expect } from "vitest";
import {
  parseFromAddress,
  parseListUnsubscribeUrl,
  stripEmailNameQuotes,
} from "@/server/email/parse-utils";

describe("stripEmailNameQuotes", () => {
  it("strips surrounding double quotes", () => {
    expect(stripEmailNameQuotes('"Brendan & Corinne Long-Hall"')).toBe(
      "Brendan & Corinne Long-Hall"
    );
  });

  it("returns unquoted name unchanged", () => {
    expect(stripEmailNameQuotes("John Doe")).toBe("John Doe");
  });

  it("returns empty string unchanged", () => {
    expect(stripEmailNameQuotes("")).toBe("");
  });

  it("returns single quote unchanged", () => {
    expect(stripEmailNameQuotes('"')).toBe('"');
  });

  it("handles name that starts with quote but does not end with quote", () => {
    expect(stripEmailNameQuotes('"John Doe')).toBe('"John Doe');
  });

  it("handles name that ends with quote but does not start with quote", () => {
    expect(stripEmailNameQuotes('John Doe"')).toBe('John Doe"');
  });

  it("handles just two quotes (empty quoted name)", () => {
    expect(stripEmailNameQuotes('""')).toBe("");
  });

  // RFC 2822 escape sequence tests
  it("unescapes escaped quotes inside quoted name", () => {
    expect(stripEmailNameQuotes('"John \\"The Boss\\" Doe"')).toBe('John "The Boss" Doe');
  });

  it("unescapes escaped backslashes inside quoted name", () => {
    expect(stripEmailNameQuotes('"C:\\\\Users\\\\John"')).toBe("C:\\Users\\John");
  });

  it("handles mixed escape sequences", () => {
    expect(stripEmailNameQuotes('"Say \\"Hello\\\\ World\\""')).toBe('Say "Hello\\ World"');
  });

  it("does not unescape sequences in unquoted names", () => {
    expect(stripEmailNameQuotes('John \\"Doe')).toBe('John \\"Doe');
  });
});

describe("parseFromAddress", () => {
  describe("Name <email> format", () => {
    it("parses simple name and email", () => {
      expect(parseFromAddress("John Doe <john@example.com>")).toEqual({
        name: "John Doe",
        address: "john@example.com",
      });
    });

    it("strips quotes from name with special characters", () => {
      expect(parseFromAddress('"Brendan & Corinne Long-Hall" <family@example.com>')).toEqual({
        name: "Brendan & Corinne Long-Hall",
        address: "family@example.com",
      });
    });

    it("strips quotes from name with comma", () => {
      expect(parseFromAddress('"Doe, John" <john@example.com>')).toEqual({
        name: "Doe, John",
        address: "john@example.com",
      });
    });

    it("unescapes quotes in quoted name", () => {
      expect(parseFromAddress('"John \\"The Boss\\" Doe" <john@example.com>')).toEqual({
        name: 'John "The Boss" Doe',
        address: "john@example.com",
      });
    });

    it("handles unquoted name with simple characters", () => {
      expect(parseFromAddress("Newsletter <news@example.com>")).toEqual({
        name: "Newsletter",
        address: "news@example.com",
      });
    });

    it("trims whitespace from name and address", () => {
      expect(parseFromAddress("  John Doe   <  john@example.com  >")).toEqual({
        name: "John Doe",
        address: "john@example.com",
      });
    });

    it("returns undefined name when name part is empty", () => {
      expect(parseFromAddress(" <john@example.com>")).toEqual({
        name: undefined,
        address: "john@example.com",
      });
    });

    it("takes the address from the last bracketed part when the name has brackets", () => {
      expect(parseFromAddress("Team <ops> <ops@example.com>")).toEqual({
        name: "Team <ops>",
        address: "ops@example.com",
      });
    });

    it("parses a name containing a line break", () => {
      expect(parseFromAddress("John\nDoe <john@example.com>")).toEqual({
        name: "John\nDoe",
        address: "john@example.com",
      });
    });

    it.each([
      ["repeated <", "a" + "<".repeat(30000) + ">>"],
      ["repeated ' <'", "a <".repeat(10000) + ">>"],
      ["a long whitespace run", "a" + " ".repeat(30000) + "<x@example.com>x"],
    ])("stays linear on %s", (_case, hostile) => {
      // `^(.+?)\s*<([^>]+)>$` took ~0.3-0.7s on each of these (quadratic).
      const started = performance.now();
      parseFromAddress(hostile);
      expect(performance.now() - started).toBeLessThan(100);
    });

    it("returns undefined name when name is just quotes", () => {
      expect(parseFromAddress('"" <john@example.com>')).toEqual({
        name: undefined,
        address: "john@example.com",
      });
    });
  });

  describe("<email> format", () => {
    it("parses email in angle brackets only", () => {
      expect(parseFromAddress("<john@example.com>")).toEqual({
        address: "john@example.com",
      });
    });

    it("trims whitespace from email in angle brackets", () => {
      expect(parseFromAddress("<  john@example.com  >")).toEqual({
        address: "john@example.com",
      });
    });
  });

  describe("plain email format", () => {
    it("parses plain email address", () => {
      expect(parseFromAddress("john@example.com")).toEqual({
        address: "john@example.com",
      });
    });

    it("trims whitespace from plain email", () => {
      expect(parseFromAddress("  john@example.com  ")).toEqual({
        address: "john@example.com",
      });
    });
  });
});

describe("parseListUnsubscribeUrl", () => {
  const header = "<mailto:unsub@example.com?subject=x>, <https://example.com/unsub>";

  it.each([
    ["mailto", "mailto:unsub@example.com?subject=x"],
    ["https", "https://example.com/unsub"],
  ] as const)("picks the %s URL", (scheme, expected) => {
    expect(parseListUnsubscribeUrl(header, scheme)).toBe(expected);
  });

  it("stays linear on repeated unclosed <mailto: fragments", () => {
    // `<(mailto:[^>]+)>` took ~0.3s here (quadratic).
    const started = performance.now();
    expect(parseListUnsubscribeUrl("<mailto:".repeat(8000), "mailto")).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
  });
});
