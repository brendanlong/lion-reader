/**
 * Unit tests for ArXiv URL detection and paper ID extraction.
 *
 * These test the pure functions that determine if a URL is from ArXiv
 * and extract the paper ID for HTML version checking.
 */

import { describe, it, expect } from "vitest";
import {
  isArxivUrl,
  isArxivTransformableUrl,
  extractPaperId,
  buildArxivHtmlUrl,
  buildArxivAbsUrl,
  parseArxivApiResponse,
  formatArxivAuthors,
} from "../../src/server/feed/arxiv";

/** A trimmed-down but structurally faithful arXiv Atom API response. */
const ARXIV_API_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: search_query=&amp;id_list=2503.11926</title>
  <entry>
    <id>http://arxiv.org/abs/2503.11926v1</id>
    <title>Monitoring Reasoning Models for Misbehavior and the Risks of
      Promoting Obfuscation</title>
    <summary>  Mitigating reward hacking--where AI systems misbehave due to flaws
      or misspecifications in their learning objectives--remains a key challenge.
      We show that we can monitor a frontier reasoning model, such as OpenAI
      o3-mini, for reward hacking.
    </summary>
    <author><name>Bowen Baker</name></author>
    <author><name>Joost Huizinga</name></author>
    <author><name>Leo Gao</name></author>
  </entry>
</feed>`;

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

  describe("isArxivTransformableUrl", () => {
    it("returns true for ArXiv abstract URLs", () => {
      expect(isArxivTransformableUrl("https://arxiv.org/abs/2601.04649")).toBe(true);
    });

    it("returns true for ArXiv PDF URLs", () => {
      expect(isArxivTransformableUrl("https://arxiv.org/pdf/2601.04649")).toBe(true);
      expect(isArxivTransformableUrl("https://arxiv.org/pdf/2601.04649.pdf")).toBe(true);
    });

    it("returns false for ArXiv HTML URLs (already HTML)", () => {
      expect(isArxivTransformableUrl("https://arxiv.org/html/2601.04649")).toBe(false);
    });

    it("returns false for non-ArXiv URLs", () => {
      expect(isArxivTransformableUrl("https://example.com/abs/2601.04649")).toBe(false);
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

describe("parseArxivApiResponse", () => {
  it("extracts the title, abstract, and author names from the entry", () => {
    const result = parseArxivApiResponse(ARXIV_API_XML);
    // Whitespace (including the line wrapping arXiv uses) is collapsed.
    expect(result.title).toBe(
      "Monitoring Reasoning Models for Misbehavior and the Risks of Promoting Obfuscation"
    );
    expect(result.summary).toBe(
      "Mitigating reward hacking--where AI systems misbehave due to flaws or " +
        "misspecifications in their learning objectives--remains a key challenge. We show " +
        "that we can monitor a frontier reasoning model, such as OpenAI o3-mini, for reward hacking."
    );
    expect(result.authors).toEqual(["Bowen Baker", "Joost Huizinga", "Leo Gao"]);
  });

  it("ignores the feed-level query title (only reads inside <entry>)", () => {
    const result = parseArxivApiResponse(ARXIV_API_XML);
    expect(result.title).not.toContain("ArXiv Query");
  });

  it("only reads the first entry when the API returns several", () => {
    const multi = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>First</title><summary>First abstract</summary>
        <author><name>Author One</name></author></entry>
      <entry><title>Second</title><summary>Second abstract</summary>
        <author><name>Author Two</name></author></entry>
    </feed>`;
    const result = parseArxivApiResponse(multi);
    expect(result.title).toBe("First");
    expect(result.summary).toBe("First abstract");
    expect(result.authors).toEqual(["Author One"]);
  });

  it("returns nulls / empty authors for a response with no entry", () => {
    const empty = `<feed xmlns="http://www.w3.org/2005/Atom">
      <title>ArXiv Query: id_list=9999.99999</title>
    </feed>`;
    expect(parseArxivApiResponse(empty)).toEqual({
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
