/**
 * Unit tests for Markdown processing utilities.
 */

import { describe, it, expect } from "vitest";
import { extractFrontmatter, processMarkdown } from "../../src/server/markdown";

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
    expect(result.frontmatter?.raw).toEqual({
      author: "John Doe",
      date: "2024-01-15",
    });
  });

  it("extracts author from frontmatter", () => {
    const markdown = `---
title: My Article
author: Jane Smith
---

Content here.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter?.title).toBe("My Article");
    expect(result.frontmatter?.author).toBe("Jane Smith");
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
    // Frontmatter block is still stripped
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

  it("falls back to H1 heading when no frontmatter", async () => {
    const markdown = `# Heading Title

Content here.`;

    const result = await processMarkdown(markdown);
    expect(result.title).toBe("Heading Title");
  });

  it("returns summary from frontmatter description", async () => {
    const markdown = `---
title: My Article
description: This is the summary.
---

Full article content.`;

    const result = await processMarkdown(markdown);
    expect(result.summary).toBe("This is the summary.");
  });

  it("returns null summary when no description in frontmatter", async () => {
    const markdown = `---
title: My Article
---

Full article content.`;

    const result = await processMarkdown(markdown);
    expect(result.summary).toBeNull();
  });

  it("returns null summary when no frontmatter", async () => {
    const markdown = `# My Article

Full article content.`;

    const result = await processMarkdown(markdown);
    expect(result.summary).toBeNull();
  });

  it("converts markdown to HTML", async () => {
    const markdown = `# Title

This is **bold** and *italic*.`;

    const result = await processMarkdown(markdown);
    expect(result.html).toContain("<strong>bold</strong>");
    expect(result.html).toContain("<em>italic</em>");
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

  it("extracts author from frontmatter", async () => {
    const markdown = `---
title: My Article
author: John Doe
---

Content here.`;

    const result = await processMarkdown(markdown);
    expect(result.author).toBe("John Doe");
  });

  it("returns null author when no author in frontmatter", async () => {
    const markdown = `---
title: My Article
---

Content here.`;

    const result = await processMarkdown(markdown);
    expect(result.author).toBeNull();
  });

  it("returns null author when no frontmatter", async () => {
    const markdown = `# My Article

Content here.`;

    const result = await processMarkdown(markdown);
    expect(result.author).toBeNull();
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
    // Reference becomes a superscript anchor pointing at the definition.
    expect(result.html).toMatch(/<sup><a[^>]*href="#footnote-src"[^>]*>1<\/a><\/sup>/);
    // Definitions are collected into a footnotes section, not left inline.
    expect(result.html).toContain('<section class="footnotes"');
    expect(result.html).toContain('id="footnote-src"');
    expect(result.html).toContain("The supporting evidence.");
    // A back-reference link returns to the citation.
    expect(result.html).toContain('href="#footnote-ref-src"');
    // No raw footnote markers survive in the output.
    expect(result.html).not.toContain("[^src]");
  });

  it("numbers multiple footnotes in reference order", async () => {
    const markdown = `First.[^a] Second.[^b]

[^a]: Alpha.
[^b]: Bravo.`;

    const result = await processMarkdown(markdown);
    expect(result.html).toMatch(/href="#footnote-a"[^>]*>1<\/a>/);
    expect(result.html).toMatch(/href="#footnote-b"[^>]*>2<\/a>/);
    expect(result.html).toContain("Alpha.");
    expect(result.html).toContain("Bravo.");
  });

  it("renders inline and display TeX as MathML", async () => {
    const markdown = `Mass-energy is $E = mc^2$.

$$\\int_0^1 x\\,dx = \\frac{1}{2}$$`;

    const result = await processMarkdown(markdown);
    // Inline math → presentation MathML.
    expect(result.html).toContain("<math");
    expect(result.html).toMatch(/<msup><mi>c<\/mi><mn>2<\/mn><\/msup>/);
    // Display math carries the block flag.
    expect(result.html).toContain('display="block"');
    expect(result.html).toContain("<mfrac>");
    // The `$…$` / `$$…$$` delimiters are consumed, not left as literal text.
    expect(result.html).not.toContain("$E = mc^2$");
    expect(result.html).not.toContain("$$");
    // Note: the TeX source still lives in the `<annotation>` at this stage; the
    // read-path sanitizer drops it (see sanitize-entry-html.test.ts).
  });

  it("does not throw on malformed TeX", async () => {
    const markdown = `Broken math: $\\frac{1}{$ and text after.`;
    // throwOnError:false — malformed TeX must not blow up processMarkdown.
    await expect(processMarkdown(markdown)).resolves.toBeDefined();
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

    it("strips punctuation and lowercases like github-slugger", async () => {
      const result = await processMarkdown("# Doc\n\n## What's *new* in v2.0?\n\nBody.");
      expect(result.html).toContain('id="whats-new-in-v20"');
    });

    it("does not accumulate slug suffixes across documents", async () => {
      // The extension's slugger is module-level state shared by every caller;
      // it must reset per parse or the second document's "Intro" becomes
      // "intro-1" and its table of contents breaks.
      const first = await processMarkdown("# Doc\n\n## Intro\n\nBody.");
      const second = await processMarkdown("# Doc\n\n## Intro\n\nBody.");
      expect(first.html).toContain('id="intro"');
      expect(second.html).toContain('id="intro"');
    });

    it("disambiguates duplicate headings within one document", async () => {
      const result = await processMarkdown("# Doc\n\n## Intro\n\nA.\n\n## Intro\n\nB.");
      expect(result.html).toContain('id="intro"');
      expect(result.html).toContain('id="intro-1"');
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
});
