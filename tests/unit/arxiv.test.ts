/**
 * Unit tests for ArXiv URL detection, paper ID extraction, and reading a
 * paper's metadata off its abstract page.
 */

import { describe, it, expect } from "vitest";
import {
  isArxivUrl,
  extractPaperId,
  buildArxivHtmlUrl,
  buildArxivAbsUrl,
  parseArxivAbsMetadata,
  formatArxivAuthors,
} from "../../src/server/feed/arxiv";

/**
 * A trimmed-down but structurally faithful arXiv abstract page <head>.
 *
 * Faithful in the ways the parser depends on: authors are surname-first in one
 * repeated tag, the abstract is hard-wrapped across lines with a leading blank,
 * and a decoy <title> element plus an og:title sit alongside the citation tags.
 * Taken from the real markup of arxiv.org/abs/2503.11926v1.
 */
const ARXIV_ABS_HTML = `<!DOCTYPE html>
<html><head>
  <title>[2503.11926] Monitoring Reasoning Models for Misbehavior</title>
  <meta name="citation_title" content="Monitoring Reasoning Models for Misbehavior and the Risks of
      Promoting Obfuscation" />
  <meta name="citation_author" content="Baker, Bowen" />
  <meta name="citation_author" content="Huizinga, Joost" />
  <meta name="citation_author" content="Gao, Leo" />
  <meta name="citation_date" content="2025/03/11" />
  <meta name="citation_arxiv_id" content="2503.11926" />
  <meta name="citation_abstract" content="  Mitigating reward hacking--where AI systems misbehave due to flaws
      or misspecifications in their learning objectives--remains a key challenge.
      We show that we can monitor a frontier reasoning model, such as OpenAI
      o3-mini, for reward hacking.
" />
  <meta property="og:title" content="Some other title" />
</head><body>
  <meta name="citation_author" content="Ignored, Body" />
</body></html>`;

describe("ArXiv URL detection", () => {
  describe("isArxivUrl", () => {
    it("returns true for ArXiv abstract URLs with new format IDs", () => {
      expect(isArxivUrl("https://arxiv.org/abs/2601.04649")).toBe(true);
      expect(isArxivUrl("https://www.arxiv.org/abs/2601.04649")).toBe(true);
    });

    it("returns true for ArXiv PDF URLs", () => {
      expect(isArxivUrl("https://arxiv.org/pdf/2601.04649")).toBe(true);
      expect(isArxivUrl("https://arxiv.org/pdf/2601.04649.pdf")).toBe(true);
    });

    it("returns true for ArXiv HTML URLs", () => {
      expect(isArxivUrl("https://arxiv.org/html/2601.04649")).toBe(true);
    });

    it("returns true for ArXiv URLs with version numbers", () => {
      expect(isArxivUrl("https://arxiv.org/abs/2601.04649v1")).toBe(true);
      expect(isArxivUrl("https://arxiv.org/abs/2601.04649v2")).toBe(true);
      expect(isArxivUrl("https://arxiv.org/pdf/2601.04649v3")).toBe(true);
    });

    it("returns true for ArXiv URLs with old format IDs (category/number)", () => {
      expect(isArxivUrl("https://arxiv.org/abs/hep-th/9901001")).toBe(true);
      expect(isArxivUrl("https://arxiv.org/pdf/math.GT/0309136")).toBe(true);
      expect(isArxivUrl("https://arxiv.org/abs/cond-mat/0001234")).toBe(true);
    });

    it("returns true for HTTP URLs (not just HTTPS)", () => {
      expect(isArxivUrl("http://arxiv.org/abs/2601.04649")).toBe(true);
    });

    it("returns true for URLs with query parameters", () => {
      expect(isArxivUrl("https://arxiv.org/abs/2601.04649?ref=foo")).toBe(true);
    });

    it("returns true for URLs with hash fragments", () => {
      expect(isArxivUrl("https://arxiv.org/abs/2601.04649#section")).toBe(true);
    });

    it("returns false for non-ArXiv URLs", () => {
      expect(isArxivUrl("https://example.com/abs/2601.04649")).toBe(false);
      expect(isArxivUrl("https://google.com")).toBe(false);
    });

    it("returns false for ArXiv non-paper URLs", () => {
      expect(isArxivUrl("https://arxiv.org")).toBe(false);
      expect(isArxivUrl("https://arxiv.org/list/cs.AI/recent")).toBe(false);
      expect(isArxivUrl("https://arxiv.org/search/?query=test")).toBe(false);
    });

    it("returns false for invalid URLs", () => {
      expect(isArxivUrl("not a url")).toBe(false);
      expect(isArxivUrl("")).toBe(false);
      expect(isArxivUrl("arxiv.org/abs/2601.04649")).toBe(false);
    });
  });

  describe("extractPaperId", () => {
    it("extracts paper ID from ArXiv abstract URLs", () => {
      expect(extractPaperId("https://arxiv.org/abs/2601.04649")).toBe("2601.04649");
      expect(extractPaperId("https://www.arxiv.org/abs/2312.00001")).toBe("2312.00001");
    });

    it("extracts paper ID from ArXiv PDF URLs", () => {
      expect(extractPaperId("https://arxiv.org/pdf/2601.04649")).toBe("2601.04649");
      expect(extractPaperId("https://arxiv.org/pdf/2601.04649.pdf")).toBe("2601.04649");
    });

    it("extracts paper ID from ArXiv HTML URLs", () => {
      expect(extractPaperId("https://arxiv.org/html/2601.04649")).toBe("2601.04649");
    });

    it("extracts paper ID with version number preserved", () => {
      expect(extractPaperId("https://arxiv.org/abs/2601.04649v1")).toBe("2601.04649v1");
      expect(extractPaperId("https://arxiv.org/abs/2601.04649v12")).toBe("2601.04649v12");
      expect(extractPaperId("https://arxiv.org/html/2602.04118v1")).toBe("2602.04118v1");
    });

    it("extracts paper ID from old format URLs", () => {
      expect(extractPaperId("https://arxiv.org/abs/hep-th/9901001")).toBe("hep-th/9901001");
      expect(extractPaperId("https://arxiv.org/pdf/math.GT/0309136")).toBe("math.GT/0309136");
    });

    it("extracts paper ID from URLs with query params", () => {
      expect(extractPaperId("https://arxiv.org/abs/2601.04649?ref=foo")).toBe("2601.04649");
    });

    it("extracts paper ID from URLs with hash fragments", () => {
      expect(extractPaperId("https://arxiv.org/abs/2601.04649#abstract")).toBe("2601.04649");
    });

    it("returns null for non-ArXiv URLs", () => {
      expect(extractPaperId("https://example.com/abs/2601.04649")).toBe(null);
    });

    it("returns null for ArXiv non-paper URLs", () => {
      expect(extractPaperId("https://arxiv.org")).toBe(null);
      expect(extractPaperId("https://arxiv.org/list/cs.AI/recent")).toBe(null);
    });

    it("returns null for invalid URLs", () => {
      expect(extractPaperId("not a url")).toBe(null);
      expect(extractPaperId("")).toBe(null);
    });
  });

  describe("buildArxivHtmlUrl", () => {
    it("builds HTML URL from new format paper ID", () => {
      expect(buildArxivHtmlUrl("2601.04649")).toBe("https://arxiv.org/html/2601.04649");
    });

    it("builds HTML URL from paper ID with version", () => {
      expect(buildArxivHtmlUrl("2601.04649v1")).toBe("https://arxiv.org/html/2601.04649v1");
    });

    it("builds HTML URL from old format paper ID", () => {
      expect(buildArxivHtmlUrl("hep-th/9901001")).toBe("https://arxiv.org/html/hep-th/9901001");
    });
  });

  describe("buildArxivAbsUrl", () => {
    it("builds abstract URL from new format paper ID", () => {
      expect(buildArxivAbsUrl("2601.04649")).toBe("https://arxiv.org/abs/2601.04649");
    });

    it("builds abstract URL from old format paper ID", () => {
      expect(buildArxivAbsUrl("hep-th/9901001")).toBe("https://arxiv.org/abs/hep-th/9901001");
    });
  });
});

describe("parseArxivAbsMetadata", () => {
  it("extracts the title, abstract, and author names from the citation tags", () => {
    const result = parseArxivAbsMetadata(ARXIV_ABS_HTML);
    // Whitespace (including the line wrapping arXiv uses) is collapsed.
    expect(result.title).toBe(
      "Monitoring Reasoning Models for Misbehavior and the Risks of Promoting Obfuscation"
    );
    expect(result.summary).toBe(
      "Mitigating reward hacking--where AI systems misbehave due to flaws or " +
        "misspecifications in their learning objectives--remains a key challenge. We show " +
        "that we can monitor a frontier reasoning model, such as OpenAI o3-mini, for reward hacking."
    );
  });

  it("rewrites surname-first author names into reading order, preserving order", () => {
    const result = parseArxivAbsMetadata(ARXIV_ABS_HTML);
    expect(result.authors).toEqual(["Bowen Baker", "Joost Huizinga", "Leo Gao"]);
  });

  it("keeps multi-part given names together when swapping", () => {
    const html = `<head><meta name="citation_author" content="Tran, Vinh Q." /></head>`;
    expect(parseArxivAbsMetadata(html).authors).toEqual(["Vinh Q. Tran"]);
  });

  it("leaves collaboration names without a comma alone", () => {
    const html = `<head><meta name="citation_author" content="ATLAS Collaboration" /></head>`;
    expect(parseArxivAbsMetadata(html).authors).toEqual(["ATLAS Collaboration"]);
  });

  it("prefers citation_title over the page title and og:title", () => {
    const result = parseArxivAbsMetadata(ARXIV_ABS_HTML);
    expect(result.title).not.toContain("[2503.11926]");
    expect(result.title).not.toBe("Some other title");
  });

  it("stops at </head> so body content cannot inject authors", () => {
    expect(parseArxivAbsMetadata(ARXIV_ABS_HTML).authors).not.toContain("Body Ignored");
  });

  it("keeps the first value when a tag is repeated", () => {
    const html = `<head>
      <meta name="citation_title" content="First" />
      <meta name="citation_title" content="Second" />
    </head>`;
    expect(parseArxivAbsMetadata(html).title).toBe("First");
  });

  it("still ignores body tags when the page omits </head>", () => {
    // htmlparser2 emits the implied close at <body>, so the pause still fires.
    const html =
      `<head><meta name="citation_author" content="Real, Ada" />` +
      `<body><meta name="citation_author" content="Injected, Body" />`;
    expect(parseArxivAbsMetadata(html).authors).toEqual(["Ada Real"]);
  });

  it("decodes HTML entities in citation values", () => {
    const html = `<head>
      <meta name="citation_title" content="Cats &amp; Dogs: A Study" />
      <meta name="citation_author" content="Balázs, Csaba" />
    </head>`;
    const result = parseArxivAbsMetadata(html);
    expect(result.title).toBe("Cats & Dogs: A Study");
    expect(result.authors).toEqual(["Csaba Balázs"]);
  });

  it("matches tag names case-insensitively", () => {
    const html = `<HEAD><META NAME="CITATION_TITLE" CONTENT="Shouty" /></HEAD>`;
    expect(parseArxivAbsMetadata(html).title).toBe("Shouty");
  });

  it("drops a stray comma when one side of the author name is empty", () => {
    const html = `<head>
      <meta name="citation_author" content="Surnameonly," />
      <meta name="citation_author" content=", Givenonly" />
    </head>`;
    expect(parseArxivAbsMetadata(html).authors).toEqual(["Surnameonly", "Givenonly"]);
  });

  it("keeps a suffix attached to the given name, as arXiv emits it", () => {
    const html = `<head><meta name="citation_author" content="Galapon, Arthur Jr." /></head>`;
    expect(parseArxivAbsMetadata(html).authors).toEqual(["Arthur Jr. Galapon"]);
  });

  it("returns nulls / empty authors for a page with no citation tags", () => {
    const html = `<head><title>arXiv is down</title></head>`;
    expect(parseArxivAbsMetadata(html)).toEqual({
      title: null,
      summary: null,
      authors: [],
    });
  });
});

describe("formatArxivAuthors", () => {
  it("returns null for an empty list", () => {
    expect(formatArxivAuthors([])).toBeNull();
  });

  it("returns the single author unchanged", () => {
    expect(formatArxivAuthors(["Ada Lovelace"])).toBe("Ada Lovelace");
  });

  it("joins two authors with 'and'", () => {
    expect(formatArxivAuthors(["Ada Lovelace", "Alan Turing"])).toBe(
      "Ada Lovelace and Alan Turing"
    );
  });

  it("collapses three or more authors to 'First Author et al.'", () => {
    expect(formatArxivAuthors(["Bowen Baker", "Joost Huizinga", "Leo Gao"])).toBe(
      "Bowen Baker et al."
    );
  });
});
