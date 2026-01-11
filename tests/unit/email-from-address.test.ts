/**
 * Unit tests for email From address parsing utilities.
 */

import { describe, it, expect } from "vitest";
import { parseFromAddress, stripEmailNameQuotes } from "@/server/email/parse-from-address";

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
