/**
 * Unit tests for GitHub plugin URL parsing, file type detection,
 * and content processing.
 */

import { describe, it, expect } from "vitest";
import {
  parseGitHubUrl,
  parseGistFilenameFromFragment,
  normalizeFilenameForFragment,
  isMarkdownFile,
  isHtmlFile,
  processFileContent,
} from "../../src/server/plugins/github";

describe("GitHub plugin URL parsing", () => {
  describe("parseGitHubUrl - gists", () => {
    it("parses gist URLs with user and gist ID", () => {
      const result = parseGitHubUrl(new URL("https://gist.github.com/brendanlong/abc123def456"));
      expect(result).toEqual({
        type: "gist",
        gistId: "abc123def456",
        filename: undefined,
      });
    });

    it("parses anonymous gist URLs (gist ID only)", () => {
      const result = parseGitHubUrl(new URL("https://gist.github.com/abc123def456"));
      expect(result).toEqual({
        type: "gist",
        gistId: "abc123def456",
        filename: undefined,
      });
    });

    it("parses gist URLs with file fragment", () => {
      const result = parseGitHubUrl(
        new URL("https://gist.github.com/brendanlong/abc123#file-readme-md")
      );
      expect(result).toEqual({
        type: "gist",
        gistId: "abc123",
        filename: "readme-md",
      });
    });

    it("parses gist URLs with file fragment containing multiple dashes", () => {
      const result = parseGitHubUrl(
        new URL("https://gist.github.com/user/gist123#file-my-cool-script-py")
      );
      expect(result).toEqual({
        type: "gist",
        gistId: "gist123",
        filename: "my-cool-script-py",
      });
    });

    it("ignores non-file fragments on gists", () => {
      const result = parseGitHubUrl(new URL("https://gist.github.com/brendanlong/abc123#comments"));
      expect(result).toEqual({
        type: "gist",
        gistId: "abc123",
        filename: undefined,
      });
    });

    it("returns null for gist.github.com root", () => {
      const result = parseGitHubUrl(new URL("https://gist.github.com/"));
      expect(result).toBeNull();
    });
  });

  describe("parseGitHubUrl - repo root", () => {
    it("parses repo root URLs", () => {
      const result = parseGitHubUrl(new URL("https://github.com/brendanlong/lion-reader"));
      expect(result).toEqual({
        type: "repo-root",
        owner: "brendanlong",
        repo: "lion-reader",
      });
    });

    it("parses repo root URLs with www prefix", () => {
      const result = parseGitHubUrl(new URL("https://www.github.com/facebook/react"));
      expect(result).toEqual({
        type: "repo-root",
        owner: "facebook",
        repo: "react",
      });
    });

    it("parses repo root URLs with trailing slash", () => {
      const result = parseGitHubUrl(new URL("https://github.com/owner/repo/"));
      expect(result).toEqual({
        type: "repo-root",
        owner: "owner",
        repo: "repo",
      });
    });
  });

  describe("parseGitHubUrl - blob URLs", () => {
    it("parses blob URLs with branch", () => {
      const result = parseGitHubUrl(
        new URL("https://github.com/brendanlong/lion-reader/blob/master/README.md")
      );
      expect(result).toEqual({
        type: "blob",
        owner: "brendanlong",
        repo: "lion-reader",
        ref: "master",
        path: "README.md",
      });
    });

    it("parses blob URLs with nested path", () => {
      const result = parseGitHubUrl(
        new URL("https://github.com/owner/repo/blob/main/src/components/Button.tsx")
      );
      expect(result).toEqual({
        type: "blob",
        owner: "owner",
        repo: "repo",
        ref: "main",
        path: "src/components/Button.tsx",
      });
    });

    it("parses blob URLs with a fully-qualified ref", () => {
      // `refs/heads/…` is unambiguous, so it must land in `ref` — the repo-root
      // base is built from the ref alone (#1423).
      const result = parseGitHubUrl(
        new URL("https://github.com/owner/repo/blob/refs/heads/main/docs/page.md")
      );
      expect(result).toEqual({
        type: "blob",
        owner: "owner",
        repo: "repo",
        ref: "refs/heads/main",
        path: "docs/page.md",
      });
    });

    it("parses blob URLs with commit SHA as ref", () => {
      const result = parseGitHubUrl(
        new URL("https://github.com/owner/repo/blob/abc123def456/file.js")
      );
      expect(result).toEqual({
        type: "blob",
        owner: "owner",
        repo: "repo",
        ref: "abc123def456",
        path: "file.js",
      });
    });

    it("parses blob URLs with tag as ref", () => {
      const result = parseGitHubUrl(
        new URL("https://github.com/owner/repo/blob/v1.0.0/package.json")
      );
      expect(result).toEqual({
        type: "blob",
        owner: "owner",
        repo: "repo",
        ref: "v1.0.0",
        path: "package.json",
      });
    });

    it("returns null for incomplete blob URLs (no path)", () => {
      const result = parseGitHubUrl(new URL("https://github.com/owner/repo/blob/main"));
      expect(result).toBeNull();
    });
  });

  describe("parseGitHubUrl - raw URLs", () => {
    it("parses raw.githubusercontent.com URLs", () => {
      const result = parseGitHubUrl(
        new URL("https://raw.githubusercontent.com/brendanlong/lion-reader/master/README.md")
      );
      expect(result).toEqual({
        type: "raw",
        owner: "brendanlong",
        repo: "lion-reader",
        ref: "master",
        path: "README.md",
      });
    });

    it("parses raw URLs with nested paths", () => {
      const result = parseGitHubUrl(
        new URL("https://raw.githubusercontent.com/owner/repo/main/docs/guide/intro.md")
      );
      expect(result).toEqual({
        type: "raw",
        owner: "owner",
        repo: "repo",
        ref: "main",
        path: "docs/guide/intro.md",
      });
    });

    it("parses raw URLs with a fully-qualified ref", () => {
      // The shape GitHub's "Raw" button emits today.
      const result = parseGitHubUrl(
        new URL("https://raw.githubusercontent.com/owner/repo/refs/heads/main/docs/page.md")
      );
      expect(result).toEqual({
        type: "raw",
        owner: "owner",
        repo: "repo",
        ref: "refs/heads/main",
        path: "docs/page.md",
      });
    });

    it("parses raw URLs with a fully-qualified tag ref", () => {
      const result = parseGitHubUrl(
        new URL("https://raw.githubusercontent.com/owner/repo/refs/tags/v1.0.0/README.md")
      );
      expect(result).toEqual({
        type: "raw",
        owner: "owner",
        repo: "repo",
        ref: "refs/tags/v1.0.0",
        path: "README.md",
      });
    });

    it("returns null for incomplete raw URLs", () => {
      const result = parseGitHubUrl(new URL("https://raw.githubusercontent.com/owner/repo/main"));
      expect(result).toBeNull();
    });
  });

  describe("parseGitHubUrl - non-matching URLs", () => {
    it("returns null for github.com user profiles", () => {
      const result = parseGitHubUrl(new URL("https://github.com/brendanlong"));
      expect(result).toBeNull();
    });

    it("returns null for github.com search", () => {
      const result = parseGitHubUrl(new URL("https://github.com/search?q=test"));
      expect(result).toBeNull();
    });

    it("returns null for github.com issues", () => {
      const result = parseGitHubUrl(new URL("https://github.com/owner/repo/issues/123"));
      expect(result).toBeNull();
    });

    it("returns null for github.com pull requests", () => {
      const result = parseGitHubUrl(new URL("https://github.com/owner/repo/pull/456"));
      expect(result).toBeNull();
    });

    it("returns null for github.com tree views (directories)", () => {
      const result = parseGitHubUrl(new URL("https://github.com/owner/repo/tree/main/src"));
      expect(result).toBeNull();
    });

    it("returns null for non-GitHub URLs", () => {
      expect(parseGitHubUrl(new URL("https://gitlab.com/owner/repo"))).toBeNull();
      expect(parseGitHubUrl(new URL("https://example.com/file.md"))).toBeNull();
    });
  });
});

describe("Gist filename fragment parsing", () => {
  describe("parseGistFilenameFromFragment", () => {
    it("parses file fragment correctly", () => {
      expect(parseGistFilenameFromFragment("#file-readme-md")).toBe("readme-md");
    });

    it("parses file fragment with complex name", () => {
      expect(parseGistFilenameFromFragment("#file-my-cool-script-py")).toBe("my-cool-script-py");
    });

    it("returns undefined for non-file fragments", () => {
      expect(parseGistFilenameFromFragment("#comments")).toBeUndefined();
      expect(parseGistFilenameFromFragment("#section")).toBeUndefined();
    });

    it("returns undefined for empty hash", () => {
      expect(parseGistFilenameFromFragment("")).toBeUndefined();
      expect(parseGistFilenameFromFragment("#")).toBeUndefined();
    });
  });

  describe("normalizeFilenameForFragment", () => {
    it("normalizes simple filenames", () => {
      expect(normalizeFilenameForFragment("README.md")).toBe("readme-md");
    });

    it("normalizes filenames with multiple dots", () => {
      expect(normalizeFilenameForFragment("config.prod.json")).toBe("config-prod-json");
    });

    it("normalizes filenames with special characters", () => {
      expect(normalizeFilenameForFragment("my_cool_script.py")).toBe("my-cool-script-py");
    });

    it("normalizes filenames with spaces", () => {
      expect(normalizeFilenameForFragment("My Document.txt")).toBe("my-document-txt");
    });

    it("collapses consecutive special characters", () => {
      expect(normalizeFilenameForFragment("file--name.txt")).toBe("file-name-txt");
    });
  });
});

describe("File type detection", () => {
  describe("isMarkdownFile", () => {
    it("returns true for .md files", () => {
      expect(isMarkdownFile("README.md")).toBe(true);
      expect(isMarkdownFile("guide.md")).toBe(true);
      expect(isMarkdownFile("CHANGELOG.MD")).toBe(true);
    });

    it("returns true for .markdown files", () => {
      expect(isMarkdownFile("doc.markdown")).toBe(true);
      expect(isMarkdownFile("NOTES.MARKDOWN")).toBe(true);
    });

    it("returns true for README without extension", () => {
      expect(isMarkdownFile("readme")).toBe(true);
      expect(isMarkdownFile("README")).toBe(true);
    });

    it("returns false for non-markdown files", () => {
      expect(isMarkdownFile("script.js")).toBe(false);
      expect(isMarkdownFile("style.css")).toBe(false);
      expect(isMarkdownFile("data.json")).toBe(false);
      expect(isMarkdownFile("readme.txt")).toBe(false);
    });
  });

  describe("isHtmlFile", () => {
    it("returns true for .html files", () => {
      expect(isHtmlFile("index.html")).toBe(true);
      expect(isHtmlFile("page.HTML")).toBe(true);
    });

    it("returns true for .htm files", () => {
      expect(isHtmlFile("page.htm")).toBe(true);
      expect(isHtmlFile("doc.HTM")).toBe(true);
    });

    it("returns false for non-html files", () => {
      expect(isHtmlFile("script.js")).toBe(false);
      expect(isHtmlFile("style.css")).toBe(false);
      expect(isHtmlFile("README.md")).toBe(false);
    });
  });
});

describe("processFileContent", () => {
  const repoFile = {
    owner: "humanlayer",
    repo: "advanced-context-engineering-for-coding-agents",
    ref: "main",
    path: "wsff.md",
  };
  const rawBase = `https://raw.githubusercontent.com/${repoFile.owner}/${repoFile.repo}/main`;
  const blobBase = `https://github.com/${repoFile.owner}/${repoFile.repo}/blob/main`;

  describe("relative URL resolution", () => {
    it("resolves relative Markdown image paths to raw.githubusercontent.com", async () => {
      const { html } = await processFileContent(
        "![A chart](images/chart.png)",
        "wsff.md",
        null,
        repoFile
      );
      expect(html).toContain(`src="${rawBase}/images/chart.png"`);
    });

    it("resolves ./-prefixed image paths the same way", async () => {
      const { html } = await processFileContent(
        "![A chart](./images/chart.png)",
        "wsff.md",
        null,
        repoFile
      );
      expect(html).toContain(`src="${rawBase}/images/chart.png"`);
    });

    it("resolves images in raw HTML blocks embedded in Markdown", async () => {
      // GitHub Markdown commonly centers figures with a raw <div><img>.
      const { html } = await processFileContent(
        '<div align="center"><img src="images/chart.png" width="50%" alt="A chart"></div>',
        "wsff.md",
        null,
        repoFile
      );
      expect(html).toContain(`src="${rawBase}/images/chart.png"`);
    });

    it("resolves images relative to the file's own directory, not the repo root", async () => {
      const { html } = await processFileContent("![Chart](charts/one.png)", "where.md", null, {
        ...repoFile,
        path: "side-quests/where.md",
      });
      expect(html).toContain(`src="${rawBase}/side-quests/charts/one.png"`);
    });

    it("resolves relative links to the github.com blob view, not raw", async () => {
      const { html } = await processFileContent(
        "[Side quest](./side-quests/where.md)",
        "wsff.md",
        null,
        repoFile
      );
      expect(html).toContain(`href="${blobBase}/side-quests/where.md"`);
    });

    it("leaves absolute URLs alone", async () => {
      const { html } = await processFileContent(
        "![Thumb](https://img.youtube.com/vi/abc/hqdefault.jpg)",
        "wsff.md",
        null,
        repoFile
      );
      expect(html).toContain('src="https://img.youtube.com/vi/abc/hqdefault.jpg"');
    });

    it("defaults to the HEAD ref when the file was fetched without one", async () => {
      const { html } = await processFileContent("![Logo](logo.png)", "README.md", null, {
        owner: "brendanlong",
        repo: "lion-reader",
        path: "README.md",
      });
      expect(html).toContain(
        'src="https://raw.githubusercontent.com/brendanlong/lion-reader/HEAD/logo.png"'
      );
    });

    it("leaves content untouched when given no repo location (gists)", async () => {
      const { html } = await processFileContent(
        "![Chart](images/chart.png)",
        "notes.md",
        null,
        null
      );
      expect(html).toContain('src="images/chart.png"');
    });

    it("resolves srcset candidates and video posters against the raw base", async () => {
      const { html } = await processFileContent(
        '<img srcset="images/small.png 1x, images/large.png 2x">' +
          '<video poster="images/poster.png"></video>',
        "wsff.md",
        null,
        repoFile
      );
      expect(html).toContain(`${rawBase}/images/small.png 1x`);
      expect(html).toContain(`${rawBase}/images/large.png 2x`);
      expect(html).toContain(`poster="${rawBase}/images/poster.png"`);
    });

    it("resolves links against the blob view at the default HEAD ref", async () => {
      const { html } = await processFileContent("[Docs](docs/guide.md)", "README.md", null, {
        owner: "brendanlong",
        repo: "lion-reader",
        path: "README.md",
      });
      expect(html).toContain(
        'href="https://github.com/brendanlong/lion-reader/blob/HEAD/docs/guide.md"'
      );
    });

    // GitHub reads a leading slash as repo-root-relative, not origin-root-relative.
    it("resolves root-relative image paths against the repo root (#1423)", async () => {
      const { html } = await processFileContent(
        '<img src="/docs/images/chart.png">',
        "wsff.md",
        null,
        repoFile
      );
      expect(html).toContain(`src="${rawBase}/docs/images/chart.png"`);
    });

    it("resolves root-relative links against the repo root (#1423)", async () => {
      const { html } = await processFileContent(
        "[Docs](/docs/guide.md)",
        "wsff.md",
        null,
        repoFile
      );
      expect(html).toContain(`href="${blobBase}/docs/guide.md"`);
    });

    it("resolves root-relative paths from a file in a subdirectory (#1423)", async () => {
      // The repo root, not the file's directory, is what a leading slash means.
      const { html } = await processFileContent(
        '<img src="/Docs/Logo.png">',
        "docs/deep/page.md",
        null,
        { ...repoFile, path: "docs/deep/page.md" }
      );
      expect(html).toContain(`src="${rawBase}/Docs/Logo.png"`);
    });

    it("keeps a fully-qualified ref intact in both bases (#1423)", async () => {
      const { html } = await processFileContent(
        '<img src="/Docs/Logo.png"><a href="/Docs/FORUMS.md">x</a>',
        "wsff.md",
        null,
        { ...repoFile, ref: "refs/heads/main" }
      );
      const { owner, repo } = repoFile;
      expect(html).toContain(
        `src="https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/main/Docs/Logo.png"`
      );
      expect(html).toContain(
        `href="https://github.com/${owner}/${repo}/blob/refs/heads/main/Docs/FORUMS.md"`
      );
    });

    it("leaves protocol-relative URLs at their own host (#1423)", async () => {
      const { html } = await processFileContent(
        '<img src="//img.example.com/chart.png">',
        "wsff.md",
        null,
        repoFile
      );
      expect(html).toContain('src="https://img.example.com/chart.png"');
    });
  });

  describe("heading ids (#1425)", () => {
    it("slugs headings so a README's table of contents resolves", async () => {
      const { html } = await processFileContent(
        "# Doc\n\n[Jump](#front-loading-alignment)\n\n## Front-loading Alignment\n\nBody.",
        "wsff.md",
        null,
        repoFile
      );
      expect(html).toContain('id="front-loading-alignment"');
      // Same-document fragments must stay relative, not get the blob base.
      expect(html).toContain('href="#front-loading-alignment"');
    });
  });

  describe("shared Markdown dialect", () => {
    // Repo files render through the app's one Markdown instance
    // (src/server/markdown), so they get the same extensions an upload does.
    it("renders math in repo files", async () => {
      const { html } = await processFileContent(
        "# Doc\n\nThe bound is $x^2$ here.",
        "README.md",
        null,
        repoFile
      );
      expect(html).toContain("<math");
    });

    it("leaves prose dollar amounts alone", async () => {
      // KaTeX's standard delimiters need a non-space before the closing `$`,
      // so ordinary README prose doesn't get parsed as a math span.
      const { html } = await processFileContent(
        "# Doc\n\nIt costs $5 and $10 to run.",
        "README.md",
        null,
        repoFile
      );
      expect(html).toContain("$5 and $10");
      expect(html).not.toContain("<math");
    });

    it("renders GFM footnotes in repo files", async () => {
      const { html } = await processFileContent(
        "# Doc\n\nClaim[^1]\n\n[^1]: The note.",
        "README.md",
        null,
        repoFile
      );
      expect(html).toContain("The note.");
      expect(html).toContain('href="#footnote-1"');
    });

    it("strips YAML frontmatter and takes its metadata", async () => {
      // Common in repo docs (Jekyll/Hugo); rendering it as text looked broken.
      const file = await processFileContent(
        "---\ntitle: Real Title\nauthor: Jane\ndescription: A summary.\n---\n\nBody text.",
        "docs/guide.md",
        null,
        repoFile
      );
      expect(file.html).toContain("Body text.");
      expect(file.html).not.toContain("title:");
      expect(file.title).toBe("Real Title");
      expect(file.author).toBe("Jane");
      expect(file.excerpt).toBe("A summary.");
    });

    it("reports no metadata for non-Markdown files", async () => {
      const file = await processFileContent("const x = 1;", "app.js", null, repoFile);
      expect(file.title).toBeNull();
      expect(file.author).toBeNull();
      expect(file.excerpt).toBeNull();
    });
  });

  describe("non-Markdown files", () => {
    it("resolves relative URLs in HTML files", async () => {
      const { html } = await processFileContent(
        '<img src="logo.png">',
        "index.html",
        null,
        repoFile
      );
      expect(html).toContain(`src="${rawBase}/logo.png"`);
    });

    it("escapes other files into a code block without rewriting URLs", async () => {
      const { html } = await processFileContent(
        'const src = "images/a.png";',
        "app.js",
        null,
        repoFile
      );
      expect(html).toContain("<pre><code>");
      expect(html).toContain("images/a.png");
      expect(html).not.toContain(rawBase);
    });
  });
});
