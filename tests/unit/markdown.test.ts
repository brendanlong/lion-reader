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

  it("ignores invalid YAML in frontmatter", () => {
    const markdown = `---
title: [invalid yaml
description: missing closing bracket
---

Content here.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe(markdown);
  });

  it("ignores non-object YAML frontmatter", () => {
    const markdown = `---
just a string value
---

Content here.`;

    const result = extractFrontmatter(markdown);
    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe(markdown);
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
});
