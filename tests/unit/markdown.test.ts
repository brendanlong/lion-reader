/**
 * Unit tests for Markdown processing utilities.
 */

import { describe, it, expect } from "vitest";
import { extractFrontmatter, processMarkdown } from "../../src/server/markdown";
import { sanitizeEntryHtml } from "../../src/server/html/sanitize";

describe("extractFrontmatter", () => {
  it("extracts title from frontmatter", () => {
    const markdown = `---
title: My Article Title
---

Content here.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter?.title).toBe("My Article Title");
    expect(result.content).toBe("\nContent here.");
  });

  it("extracts description from frontmatter", () => {
    const markdown = `---
title: My Article
description: This is a summary of the article.
---

Content here.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter?.title).toBe("My Article");
    expect(result.frontmatter?.description).toBe("This is a summary of the article.");
  });

  it("returns null frontmatter when none present", () => {
    const markdown = `# Regular Heading

Just some content.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe(markdown);
  });

  it("handles frontmatter without title or description", () => {
    const markdown = `---
author: John Doe
date: 2024-01-15
---

Content.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter?.title).toBeUndefined();
    expect(result.frontmatter?.description).toBeUndefined();
    expect(result.frontmatter?.author).toBe("John Doe");
  });

  it("trims whitespace from author", () => {
    const markdown = `---
author: "  Padded Author  "
---

Content.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter?.author).toBe("Padded Author");
  });

  it("handles empty author", () => {
    const markdown = `---
title: My Article
author: ""
---

Content.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter?.author).toBeUndefined();
  });

  it("handles Cloudflare docs style frontmatter", () => {
    const markdown = `---
title: Overview · Cloudflare Workers docs
description: "With Cloudflare Workers, you can expect to:"
lastUpdated: 2026-01-26T13:23:46.000Z
chatbotDeprioritize: false
source_url:
  html: https://developers.cloudflare.com/workers/
  md: https://developers.cloudflare.com/workers/
---

A serverless platform for building, deploying, and scaling apps.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter?.title).toBe("Overview · Cloudflare Workers docs");
    expect(result.frontmatter?.description).toBe("With Cloudflare Workers, you can expect to:");
    expect(result.content.trim()).toBe(
      "A serverless platform for building, deploying, and scaling apps."
    );
  });

  it("handles unquoted colons in values via lenient fallback", () => {
    const markdown = `---
description: A model that does X
title: Parcae: Doing more with fewer parameters
image: https://example.com/image.jpg
---

Content here.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter?.title).toBe("Parcae: Doing more with fewer parameters");
    expect(result.frontmatter?.description).toBe("A model that does X");
    expect(result.content).toBe("\nContent here.");
  });

  it("handles unquoted colons with CRLF line endings via lenient fallback", () => {
    const markdown =
      "---\r\ntitle: Parcae: Doing more\r\ndescription: A summary\r\n---\r\n\r\nContent.";

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter?.title).toBe("Parcae: Doing more");
    expect(result.frontmatter?.description).toBe("A summary");
  });

  it("strips YAML array frontmatter from content", () => {
    const markdown = `---
- item1
- item2
---

Content here.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe("\nContent here.");
  });

  it("strips frontmatter from content even when YAML is completely invalid", () => {
    const markdown = `---
not: valid: yaml: here
also not valid
---

Content here.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).toBeNull();
    // Frontmatter block is still stripped from content
    expect(result.content).toBe("\nContent here.");
  });

  it("strips frontmatter from content for non-object YAML", () => {
    const markdown = `---
just a string value
---

Content here.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe("\nContent here.");
  });

  it("closes frontmatter on a `...` end-of-document marker (#1280)", () => {
    // gwern.net / Pandoc close YAML frontmatter with `...`, not `---`. Accepting
    // only `---` made the lazy matcher run past this terminator to the first
    // later `---` thematic break, swallowing the intro as frontmatter.
    const markdown = `---
title: Catapulting
confidence: unlikely
...

Intro paragraph that must survive.

# Intelligence, Broadly

A scaling-centric view.

---

# Anomalies`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter?.title).toBe("Catapulting");
    // The intro, the heading, and the thematic break all remain in the body.
    expect(result.content).toContain("Intro paragraph that must survive.");
    expect(result.content).toContain("# Intelligence, Broadly");
    expect(result.content).toContain("A scaling-centric view.");
    // The `---` thematic break is body content, not a frontmatter closer.
    expect(result.content).toContain("\n---\n");
    // The YAML must not leak into the body.
    expect(result.content).not.toContain("confidence: unlikely");
  });

  it("handles `...` end marker with CRLF line endings (#1280)", () => {
    const markdown = "---\r\ntitle: Windows Dots\r\n...\r\n\r\nBody content.";

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter?.title).toBe("Windows Dots");
    expect(result.content).toBe("\r\nBody content.");
  });

  it("requires frontmatter at document start", () => {
    const markdown = `Some text before

---
title: Not frontmatter
---

More content.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe(markdown);
  });

  it("handles CRLF line endings", () => {
    const markdown = "---\r\ntitle: Windows Style\r\n---\r\n\r\nContent.";

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter?.title).toBe("Windows Style");
  });

  it("handles empty title or description", () => {
    const markdown = `---
title: ""
description:
---

Content.`;

    const result = extractFrontmatter(markdown);
    // Empty strings should not be set as title/description
    expect(result.frontmatter?.title).toBeUndefined();
    expect(result.frontmatter?.description).toBeUndefined();
  });

  it("trims whitespace from title and description", () => {
    const markdown = `---
title: "  Padded Title  "
description: "  Padded Description  "
---

Content.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter?.title).toBe("Padded Title");
    expect(result.frontmatter?.description).toBe("Padded Description");
  });
});

describe("processMarkdown", () => {
  it("extracts title from frontmatter over H1 heading", async () => {
    const markdown = `---
title: Frontmatter Title
---

# Heading Title

Content here.`;

    const result = await processMarkdown(markdown);
    expect(result.title).toBe("Frontmatter Title");
  });

  it("falls back to H1 heading when no frontmatter title", async () => {
    const markdown = `---
author: John Doe
---

# Heading Title

Content here.`;

    const result = await processMarkdown(markdown);
    expect(result.title).toBe("Heading Title");
  });

  it("returns null summary and author when frontmatter lacks them", async () => {
    const markdown = `---
title: My Article
---

Full article content.`;

    const result = await processMarkdown(markdown);
    expect(result.summary).toBeNull();
    expect(result.author).toBeNull();
  });

  it("returns null summary and author when there is no frontmatter", async () => {
    const markdown = `# My Article

Full article content.`;

    const result = await processMarkdown(markdown);
    expect(result.summary).toBeNull();
    expect(result.author).toBeNull();
  });

  it("strips title header from HTML output", async () => {
    const markdown = `# Title

Content.`;

    const result = await processMarkdown(markdown);
    expect(result.html).not.toContain("<h1>");
    expect(result.title).toBe("Title");
  });

  it("handles Cloudflare docs example", async () => {
    const markdown = `---
title: Overview · Cloudflare Workers docs
description: "With Cloudflare Workers, you can expect to:"
lastUpdated: 2026-01-26T13:23:46.000Z
chatbotDeprioritize: false
source_url:
  html: https://developers.cloudflare.com/workers/
  md: https://developers.cloudflare.com/workers/
---

A serverless platform for building, deploying, and scaling apps across [Cloudflare's global network](https://www.cloudflare.com/network/) with a single command — no infrastructure to manage, no complex configuration`;

    const result = await processMarkdown(markdown);
    expect(result.title).toBe("Overview · Cloudflare Workers docs");
    expect(result.summary).toBe("With Cloudflare Workers, you can expect to:");
    expect(result.html).toContain("serverless platform");
    expect(result.html).toContain('<a href="https://www.cloudflare.com/network/">');
  });

  it("extracts all metadata from frontmatter", async () => {
    const markdown = `---
title: Complete Article
description: A brief summary.
author: Jane Smith
---

The full content of the article.`;

    const result = await processMarkdown(markdown);
    expect(result.title).toBe("Complete Article");
    expect(result.summary).toBe("A brief summary.");
    expect(result.author).toBe("Jane Smith");
    expect(result.html).toContain("full content");
  });

  it("keeps the intro when frontmatter is closed with `...` (#1280)", async () => {
    // Regression: gwern-style frontmatter (`...` closer) followed by an intro,
    // a heading, and a `---` thematic break. The intro must not be swallowed.
    const markdown = `---
title: Catapulting
importance: 10
...

<div class="abstract">
An abstract summarizing the article.
</div>

Because deep learning has continued to scale up, the intro begins here.

# Intelligence, Broadly

A scaling-centric view might be summed up like this:

---

# Anomalies

But this paradigm doesn't explain everything.`;

    const result = await processMarkdown(markdown);
    expect(result.title).toBe("Catapulting");
    expect(result.html).toContain("An abstract summarizing the article.");
    expect(result.html).toContain("the intro begins here");
    expect(result.html).toContain("Intelligence, Broadly");
    expect(result.html).toContain("Anomalies");
    // The YAML metadata must not leak into the rendered body.
    expect(result.html).not.toContain("importance:");
  });

  it("renders GFM footnotes instead of leaking literal syntax", async () => {
    const markdown = `A claim that needs support.[^src]

Body continues here.

[^src]: The supporting evidence.`;

    const result = await processMarkdown(markdown);
    // The `fn-` / `fnref-` anchor names are GitHub's own.
    expect(result.html).toMatch(/<sup[^>]*><a[^>]*href="#fn-src"[^>]*>1<\/a><\/sup>/);
    expect(result.html).toContain('<section class="footnotes"');
    expect(result.html).toContain('id="fn-src"');
    expect(result.html).toContain("The supporting evidence.");
    expect(result.html).toContain('href="#fnref-src"');
    expect(result.html).not.toContain("[^src]");
  });

  it("numbers multiple footnotes in reference order", async () => {
    const markdown = `First.[^a] Second.[^b]

[^a]: Alpha.
[^b]: Bravo.`;

    const result = await processMarkdown(markdown);
    expect(result.html).toMatch(/href="#fn-a"[^>]*>1<\/a>/);
    expect(result.html).toMatch(/href="#fn-b"[^>]*>2<\/a>/);
    expect(result.html).toContain("Alpha.");
    expect(result.html).toContain("Bravo.");
  });

  it("handles frontmatter with unquoted colons in values (#818)", async () => {
    const markdown = `---
description: A model that matches quality
title: Parcae: Doing more with fewer parameters
image: https://example.com/image.jpg
---

This paper introduces Parcae.`;

    const result = await processMarkdown(markdown);
    expect(result.title).toBe("Parcae: Doing more with fewer parameters");
    expect(result.summary).toBe("A model that matches quality");
    expect(result.html).not.toContain("description:");
    expect(result.html).not.toContain("image:");
    expect(result.html).toContain("Parcae");
  });

  describe("heading ids (#1425)", () => {
    it("gives headings GitHub-compatible slugs so a table of contents resolves", async () => {
      const result = await processMarkdown(
        "# Doc\n\n[Jump](#front-loading-alignment)\n\n## Front-loading Alignment\n\nBody."
      );
      // The slug an author writing against GitHub's rules would expect.
      expect(result.html).toContain('id="front-loading-alignment"');
      expect(result.html).toContain('href="#front-loading-alignment"');
    });

    it("leaves a link to the stripped title heading dangling", async () => {
      // processMarkdown removes the leading heading (it becomes the article
      // title), so its slug goes with it. A table of contents linking to the
      // document's own title is the one anchor that can't resolve.
      const result = await processMarkdown("# My Doc\n\n[Top](#my-doc)\n\nBody.");
      expect(result.title).toBe("My Doc");
      expect(result.html).not.toContain('id="my-doc"');
      expect(result.html).toContain('href="#my-doc"');
    });
  });

  /**
   * Markdown *grows* on the way to HTML, so the raw-bytes limit the caller
   * applies to a fetched document is the wrong budget for the renderer. Both
   * budgets are therefore enforced inside the renderer, and the output one
   * aborts the render rather than measuring the finished string (#1431).
   */
  describe("size budgets (#1431)", () => {
    /** The `maxBytes` a rejection reports, which is what tells the two apart. */
    const rejectedLimit = async (markdown: string): Promise<number | undefined> => {
      try {
        await processMarkdown(markdown);
        return undefined;
      } catch (error) {
        const cause = (error as { cause?: { details?: { maxBytes?: number } } }).cause;
        return cause?.details?.maxBytes;
      }
    };

    it("rejects Markdown over the input cap", async () => {
      // 1.5 MB of prose, over the 1 MB input cap but nowhere near amplifying.
      expect(await rejectedLimit("word ".repeat(300_000))).toBe(1024 * 1024);
    });

    it("rejects a document that amplifies past the output budget", async () => {
      // Math-dense input *inside* the 1 MB input cap — the shape from #1431,
      // where the old renderer expanded ~29x and only got measured afterwards.
      // Asserting on the reported limit is what distinguishes this from the
      // test above: both throw the same "maximum size" wording.
      const markdown = "$a_1^2$ ".repeat(130_000); // ~1.04 MB in, ~10 MB out
      expect(markdown.length).toBeLessThan(1024 * 1024);
      expect(await rejectedLimit(markdown)).toBe(5 * 1024 * 1024);
    });

    it("renders a large ordinary document well inside both budgets", async () => {
      // Prose amplifies ~1.3x, so a document near the input cap is fine —
      // the budgets must not reject legitimately long articles.
      const result = await processMarkdown("Lorem ipsum dolor sit amet.\n\n".repeat(20_000));
      expect(result.html).toContain("Lorem ipsum");
    });
  });

  /**
   * Rendering above the inline threshold is handed to the libuv thread pool, so
   * a large document doesn't block the event loop the way the old synchronous
   * renderer did (#1431). What's observable from here is that the offloaded
   * path produces the same HTML as the inline one and that concurrent renders
   * don't corrupt each other's heading slugs.
   */
  describe("thread-pool offload (#1431)", () => {
    /** The leading `# Doc` is stripped as the title, so `## Intro` survives. */
    const head = "# Doc\n\n## Intro\n\nBody with $E = mc^2$ math.\n";
    /** Pushes a document comfortably past the ~10 KB inline threshold. */
    const padding = `\n${"Filler paragraph text. ".repeat(1000)}`;

    it("renders an offloaded document the same way as an inline one", async () => {
      const inline = await processMarkdown(head);
      const offloaded = await processMarkdown(head + padding);
      expect(head.length).toBeLessThan(10 * 1024);
      expect((head + padding).length).toBeGreaterThan(10 * 1024);
      // The padded document is the inline one plus a trailing paragraph, so the
      // two renderers must agree byte for byte on everything before it.
      expect(offloaded.html.startsWith(inline.html.trimEnd())).toBe(true);
    });

    it("keeps concurrent renders from sharing a heading occurrence table", async () => {
      // The hazard the old module-level slugger had: interleaved documents
      // slugging against each other's counts, so one comes out "intro-1".
      const results = await Promise.all(
        Array.from({ length: 8 }, () => processMarkdown(head + padding))
      );
      for (const result of results) {
        expect(result.html).toContain('<h2 id="intro">');
        expect(result.html).not.toContain('id="intro-1"');
      }
    });
  });
});

/**
 * The user-visible claim of #1425 is that a link in rendered Markdown actually
 * lands somewhere. That spans two subsystems — Markdown rendering generates the
 * ids, and the read-path sanitizer namespaces both sides — so neither unit test
 * alone proves it. These drive the seam.
 */
describe("rendered Markdown through the read-path sanitizer (#1425)", () => {
  const render = async (markdown: string): Promise<string> => {
    const { html } = await processMarkdown(markdown);
    return sanitizeEntryHtml(html) ?? "";
  };

  /** Every `href="#…"` that has no element with the matching id. */
  const danglingAnchors = (html: string): string[] => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const targets = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    return [...new Set(targets.filter((t) => !ids.has(t)))];
  };

  it("resolves a table of contents to its headings", async () => {
    const html = await render(
      "# Doc\n\n- [Intro](#intro)\n- [Details](#details)\n\n## Intro\n\nA.\n\n## Details\n\nB."
    );
    expect(danglingAnchors(html)).toEqual([]);
    // Namespaced as a set, and still same-document rather than off-site.
    expect(html).toContain('href="#uc-intro"');
    expect(html).toContain('id="uc-intro"');
  });

  it("resolves footnote markers and their back-links", async () => {
    const html = await render(
      "# Doc\n\nA claim[^1] and another[^2].\n\n[^1]: First.\n[^2]: Second."
    );
    expect(danglingAnchors(html)).toEqual([]);
  });

  it("keeps in-page links out of a new tab", async () => {
    // An absolutized anchor would pick up target="_blank" from the sanitizer's
    // external-link transform, opening a tab for what should be a scroll.
    const html = await render("# Doc\n\n[Intro](#intro)\n\n## Intro\n\nA.");
    expect(html).not.toMatch(/href="#[^"]*"[^>]*target="_blank"/);
  });

  it("still opens genuinely external links in a new tab", async () => {
    const html = await render("# Doc\n\n[Out](https://example.com/x)");
    expect(html).toContain('target="_blank"');
  });
});
