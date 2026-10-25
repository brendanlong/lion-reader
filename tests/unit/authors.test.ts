import { describe, it, expect } from "vitest";
import { formatAuthors, MAX_LISTED_AUTHORS } from "../../src/server/feed/authors";

const names = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `Author ${i + 1}`);

describe("formatAuthors", () => {
  it("returns null when there are no non-blank names", () => {
    expect(formatAuthors([])).toBeNull();
    expect(formatAuthors(["", "  "])).toBeNull();
  });

  it("returns a single author unchanged", () => {
    expect(formatAuthors(["Ada Lovelace"])).toBe("Ada Lovelace");
  });

  it("joins two authors with 'and'", () => {
    expect(formatAuthors(["Ada Lovelace", " ", "Alan Turing"])).toBe(
      "Ada Lovelace and Alan Turing"
    );
  });

  it("lists every author up to the limit", () => {
    const listed = formatAuthors(names(MAX_LISTED_AUTHORS));
    expect(listed).not.toContain("et al.");
    for (const name of names(MAX_LISTED_AUTHORS)) expect(listed).toContain(name);
  });

  it("collapses lists past the limit to 'First Author et al.'", () => {
    expect(formatAuthors(names(MAX_LISTED_AUTHORS + 1))).toBe("Author 1 et al.");
  });
});
