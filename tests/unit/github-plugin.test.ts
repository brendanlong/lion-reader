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
  buildGistHtml,
  shouldRetryUnauthenticated,
} from "../../src/server/plugins/github";
import type { GistFile, GistResponse } from "../../src/server/plugins/github";

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

    // The cases below are GitHub's live output for a gist holding that filename.
    it("keeps underscores, which GitHub doesn't dash out", () => {
      expect(normalizeFilenameForFragment("my_cool_script.py")).toBe("my_cool_script-py");
    });

    it("keeps a leading underscore but trims a leading dash", () => {
      expect(normalizeFilenameForFragment("_Summary.md")).toBe("_summary-md");
      expect(normalizeFilenameForFragment(".md")).toBe("md");
    });

    it("normalizes filenames with spaces", () => {
      expect(normalizeFilenameForFragment("My Document.txt")).toBe("my-document-txt");
    });

    it("collapses consecutive special characters", () => {
      expect(normalizeFilenameForFragment("file--name.txt")).toBe("file-name-txt");
      expect(normalizeFilenameForFragment("log-📂・outros・rlk_do_odio0188.html")).toBe(
        "log-outros-rlk_do_odio0188-html"
      );
    });

    it("transliterates accented characters instead of dropping them", () => {
      expect(normalizeFilenameForFragment("datenschutzerklärung.md")).toBe(
        "datenschutzerklarung-md"
      );
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
    kind: "repo" as const,
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
        kind: "repo",
        owner: "brendanlong",
        repo: "lion-reader",
        path: "README.md",
      });
      expect(html).toContain(
        'src="https://raw.githubusercontent.com/brendanlong/lion-reader/HEAD/logo.png"'
      );
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
        kind: "repo",
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

  describe("gist relative URL resolution (#1424)", () => {
    const gistFile = {
      kind: "gist" as const,
      rawUrl: "https://gist.githubusercontent.com/brendanlong/abc123/raw/deadbeef/notes.md",
    };
    const gistRawBase = "https://gist.githubusercontent.com/brendanlong/abc123/raw";
    const COMMIT_SHA = "cbc18f3161df2b2dd22f3c4944d67cebb97ae544";

    it("resolves a sibling image reference to the gist's raw host", async () => {
      const { html } = await processFileContent("![Chart](chart.png)", "notes.md", null, gistFile);
      expect(html).toContain(`src="${gistRawBase}/chart.png"`);
    });

    it("drops the blob sha in raw_url, which would serve the wrong file", async () => {
      const { html } = await processFileContent("![Chart](chart.png)", "notes.md", null, gistFile);
      expect(html).not.toContain("deadbeef");
    });

    it("pins to the gist's revision when the response carried its history", async () => {
      const { html } = await processFileContent("![Chart](chart.png)", "notes.md", null, {
        ...gistFile,
        revision: COMMIT_SHA,
      });
      expect(html).toContain(`src="${gistRawBase}/${COMMIT_SHA}/chart.png"`);
    });

    it("ignores a revision that isn't a git object name", async () => {
      // It lands in a URL path we build, so it may only ever be a sha.
      const { html } = await processFileContent("![Chart](chart.png)", "notes.md", null, {
        ...gistFile,
        revision: "../../../evil",
      });
      expect(html).toContain(`src="${gistRawBase}/chart.png"`);
    });

    it("resolves ./-prefixed references the same way", async () => {
      const { html } = await processFileContent(
        "![Chart](./chart.png)",
        "notes.md",
        null,
        gistFile
      );
      expect(html).toContain(`src="${gistRawBase}/chart.png"`);
    });

    it("resolves a link to the raw file when the gist's file list is unknown", async () => {
      const { html } = await processFileContent("[Setup](setup.md)", "notes.md", null, gistFile);
      expect(html).toContain(`href="${gistRawBase}/setup.md"`);
    });

    it("resolves root-relative references to the sibling file", async () => {
      const { html } = await processFileContent(
        '<img src="/chart.png">',
        "notes.md",
        null,
        gistFile
      );
      expect(html).toContain(`src="${gistRawBase}/chart.png"`);
    });

    it("leaves absolute URLs alone", async () => {
      const { html } = await processFileContent(
        "![Chart](https://img.example.com/chart.png)",
        "notes.md",
        null,
        gistFile
      );
      expect(html).toContain('src="https://img.example.com/chart.png"');
    });

    it("keeps same-document fragments relative", async () => {
      const { html } = await processFileContent(
        "# Doc\n\n[Jump](#setup)\n\n## Setup\n\nBody.",
        "notes.md",
        null,
        gistFile
      );
      expect(html).toContain('href="#setup"');
    });

    it("leaves content untouched when the raw URL isn't GitHub's raw gist host", async () => {
      const { html } = await processFileContent("![Chart](chart.png)", "notes.md", null, {
        kind: "gist",
        rawUrl: "https://evil.example.com/brendanlong/abc123/raw/deadbeef/notes.md",
      });
      expect(html).toContain('src="chart.png"');
    });

    it("leaves content untouched when the raw URL isn't the shape we know", async () => {
      const { html } = await processFileContent("![Chart](chart.png)", "notes.md", null, {
        kind: "gist",
        rawUrl: "https://gist.githubusercontent.com/brendanlong/abc123/notes.md",
      });
      expect(html).toContain('src="chart.png"');
    });

    it("leaves content untouched when the raw URL isn't https", async () => {
      const { html } = await processFileContent("![Chart](chart.png)", "notes.md", null, {
        kind: "gist",
        rawUrl: "http://gist.githubusercontent.com/brendanlong/abc123/raw/deadbeef/notes.md",
      });
      expect(html).toContain('src="chart.png"');
    });

    it("resolves srcset candidates and video posters against the raw base", async () => {
      const { html } = await processFileContent(
        '<img srcset="small.png 1x, large.png 2x"><video poster="poster.png"></video>',
        "notes.md",
        null,
        gistFile
      );
      expect(html).toContain(`${gistRawBase}/small.png 1x`);
      expect(html).toContain(`${gistRawBase}/large.png 2x`);
      expect(html).toContain(`poster="${gistRawBase}/poster.png"`);
    });
  });

  describe("gist sibling links (#1459)", () => {
    const gistFile = {
      kind: "gist" as const,
      rawUrl: "https://gist.githubusercontent.com/brendanlong/abc123/raw/deadbeef/notes.md",
      filenames: ["notes.md", "setup.md", "chart.png", "my script.py", "sub-dir.md"],
    };
    const gistRawBase = "https://gist.githubusercontent.com/brendanlong/abc123/raw";
    const gistPage = "https://gist.github.com/brendanlong/abc123";

    const render = (markdown: string): Promise<{ html: string }> =>
      processFileContent(markdown, "notes.md", null, gistFile);

    it("sends a link to a sibling file to that file's anchor on the gist page", async () => {
      const { html } = await render("[Setup](setup.md)");
      expect(html).toContain(`href="${gistPage}#file-setup-md"`);
    });

    it("resolves ./- and /-prefixed links to the same anchor", async () => {
      const { html } = await render('[a](./setup.md) <a href="/setup.md">b</a>');
      expect(html).not.toContain(gistRawBase);
      expect(html.match(new RegExp(`${gistPage}#file-setup-md`, "g"))).toHaveLength(2);
    });

    it("emits the anchor GitHub generates for a filename it has to normalize", async () => {
      const { html } = await render("[Script](my%20script.py)");
      expect(html).toContain(`href="${gistPage}#file-my-script-py"`);
    });

    it("matches a filename whose case the link got wrong", async () => {
      // The anchor GitHub generates is lowercased either way, so the link works.
      const { html } = await render("[Setup](SETUP.md)");
      expect(html).toContain(`href="${gistPage}#file-setup-md"`);
    });

    it("produces an anchor Lion Reader can parse back to the file", async () => {
      const { html } = await render("[Setup](setup.md)");
      const href = html.match(/href="([^"]+)"/)?.[1];
      expect(parseGitHubUrl(new URL(href ?? ""))).toEqual({
        type: "gist",
        gistId: "abc123",
        filename: "setup-md",
      });
    });

    it("leaves an embedded image on the raw host", async () => {
      // GitHub gives an <img> the same #file- anchor, which points at an HTML
      // page — the one place its own gist rendering is broken.
      const { html } = await render("![Chart](chart.png)");
      expect(html).toContain(`src="${gistRawBase}/chart.png"`);
    });

    it("keeps the raw URL for a link naming a file the gist doesn't have", async () => {
      const { html } = await render("[Missing](nope.md)");
      expect(html).toContain(`href="${gistRawBase}/nope.md"`);
    });

    it("keeps the raw URL for a link carrying its own fragment or query", async () => {
      const { html } = await render("[a](setup.md#install) [b](setup.md?raw=1)");
      expect(html).toContain(`href="${gistRawBase}/setup.md#install"`);
      expect(html).toContain(`href="${gistRawBase}/setup.md?raw=1"`);
    });

    it("leaves same-document fragments and absolute links alone", async () => {
      const { html } = await render("[Jump](#setup) [Away](https://example.com/setup.md)");
      expect(html).toContain('href="#setup"');
      expect(html).toContain('href="https://example.com/setup.md"');
    });

    it("keeps the raw URL for a path that merely normalizes to a file's anchor", async () => {
      // A gist is flat, so `sub/dir.md` names nothing — but dashing the slash
      // out would land it on the unrelated `sub-dir.md`.
      const { html } = await render("[Nested](sub/dir.md)");
      expect(html).toContain(`href="${gistRawBase}/sub/dir.md"`);
    });

    it("pins the anchor to the same revision the raw URLs are pinned to", async () => {
      // Otherwise a saved article's embeds stay frozen while its links drift.
      const sha = "cbc18f3161df2b2dd22f3c4944d67cebb97ae544";
      const { html } = await processFileContent("[Setup](setup.md)", "notes.md", null, {
        ...gistFile,
        revision: sha,
      });
      expect(html).toContain(`href="${gistPage}/${sha}#file-setup-md"`);
    });

    it("still parses a pinned anchor back to the file", async () => {
      const sha = "cbc18f3161df2b2dd22f3c4944d67cebb97ae544";
      expect(parseGitHubUrl(new URL(`${gistPage}/${sha}#file-setup-md`))).toEqual({
        type: "gist",
        gistId: "abc123",
        filename: "setup-md",
      });
    });

    it("leaves the anchor unpinned when the revision isn't a git object name", async () => {
      const { html } = await processFileContent("[Setup](setup.md)", "notes.md", null, {
        ...gistFile,
        revision: "../../../evil",
      });
      expect(html).toContain(`href="${gistPage}#file-setup-md"`);
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
      expect(html).toContain('href="#fn-1"');
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

describe("buildGistHtml", () => {
  const gistFile = (filename: string, content: string, type = "text/plain"): GistFile => ({
    filename,
    language: filename.endsWith(".md") ? "Markdown" : null,
    content,
    raw_url: `https://gist.githubusercontent.com/brendanlong/abc123/raw/deadbeef/${filename}`,
    type,
  });
  const gist = (files: GistFile[], history?: { version: string }[]): GistResponse => ({
    id: "abc123",
    description: null,
    files: Object.fromEntries(files.map((f) => [f.filename, f])),
    history,
    created_at: "2026-07-29T00:00:00Z",
    updated_at: "2026-07-29T00:00:00Z",
  });
  const rawBase = "https://gist.githubusercontent.com/brendanlong/abc123/raw";

  // The wiring the resolution above depends on: a gist file reaches
  // processFileContent with a location built from its own raw_url.
  it("resolves the sibling references of a gist's only file", async () => {
    const { html } = await buildGistHtml(gist([gistFile("notes.md", "![Chart](chart.png)")]));
    expect(html).toContain(`src="${rawBase}/chart.png"`);
  });

  it("resolves them for every file of a multi-file gist", async () => {
    const { html } = await buildGistHtml(
      gist([gistFile("a.md", "![A](a.png)"), gistFile("b.md", "![B](b.png)")])
    );
    expect(html).toContain(`src="${rawBase}/a.png"`);
    expect(html).toContain(`src="${rawBase}/b.png"`);
  });

  // The other half of that wiring (#1459): a link only becomes a gist-page
  // anchor when the file it names is in the gist, which only buildGistHtml knows.
  it("links between a gist's files through the gist page", async () => {
    const { html } = await buildGistHtml(
      gist([gistFile("a.md", "[B](b.md) [Gone](c.md)"), gistFile("b.md", "B")])
    );
    expect(html).toContain('href="https://gist.github.com/brendanlong/abc123#file-b-md"');
    expect(html).toContain(`href="${rawBase}/c.md"`);
  });

  it("resolves them for a single requested file", async () => {
    const { html } = await buildGistHtml(
      gist([gistFile("notes.md", "![Chart](chart.png)"), gistFile("other.md", "Other")]),
      "notes-md"
    );
    expect(html).toContain(`src="${rawBase}/chart.png"`);
  });

  it("finds the file a GitHub #file- fragment names when it has an underscore", async () => {
    // GitHub keeps underscores in the fragment, so dashing them out matched no file.
    const { html } = await buildGistHtml(
      gist([gistFile("agent_patch.diff", "the patch"), gistFile("other.md", "Other")]),
      "agent_patch-diff"
    );
    expect(html).toContain("the patch");
    expect(html).not.toContain("Other");
  });

  // The API returns a binary file's bytes base64-encoded in `content`, which the
  // code-block fallback rendered as screenfuls of base64.
  describe("binary files", () => {
    const base64Png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAG7buVgAAAABJRU5ErkJggg==";

    it("renders an image file as an image, not base64", async () => {
      const { html } = await buildGistHtml(
        gist([gistFile("README.md", "# Doc"), gistFile("chart.png", base64Png, "image/png")])
      );
      expect(html).toContain(`<img src="${rawBase}/chart.png" alt="chart.png">`);
      expect(html).not.toContain("iVBORw0KGgo");
    });

    it("links other binary files instead of dumping them", async () => {
      const { html } = await buildGistHtml(
        gist([gistFile("README.md", "# Doc"), gistFile("clip.mp4", base64Png, "video/mp4")])
      );
      expect(html).toContain(`href="${rawBase}/clip.mp4"`);
      expect(html).not.toContain("iVBORw0KGgo");
    });

    // That link stands in for the file itself, so unlike a link a file's author
    // wrote (#1459) it must reach the bytes, not the gist page's "(not shown)".
    it("links a binary file to its bytes, not the gist page", async () => {
      const { html } = await buildGistHtml(
        gist([
          gistFile("README.md", "[Clip](clip.mp4)"),
          gistFile("clip.mp4", base64Png, "video/mp4"),
        ])
      );
      expect(html).toContain(`href="${rawBase}/clip.mp4">clip.mp4</a>`);
      // The README's own link to it still goes to the gist page.
      expect(html).toContain('href="https://gist.github.com/brendanlong/abc123#file-clip-mp4"');
    });

    // An unknown application/* type is far more often source code than a binary.
    it("still renders an unrecognized application type as text", async () => {
      const { html } = await buildGistHtml(
        gist([
          gistFile("README.md", "# Doc"),
          gistFile("script.py", "print(1)", "application/x-python"),
        ])
      );
      expect(html).toContain("print(1)");
    });

    it("renders a lone image gist as an image", async () => {
      const { html } = await buildGistHtml(gist([gistFile("chart.png", base64Png, "image/png")]));
      expect(html).toContain(`<img src="${rawBase}/chart.png"`);
      expect(html).not.toContain("iVBORw0KGgo");
    });

    it("renders a requested image file as an image", async () => {
      const { html } = await buildGistHtml(
        gist([gistFile("README.md", "# Doc"), gistFile("chart.png", base64Png, "image/png")]),
        "chart-png"
      );
      expect(html).toContain(`<img src="${rawBase}/chart.png"`);
      expect(html).not.toContain("iVBORw0KGgo");
    });

    it("escapes a filename with HTML-significant characters", async () => {
      const { html } = await buildGistHtml(
        gist([gistFile('a"<b>.png', base64Png, "image/png"), gistFile("README.md", "# Doc")])
      );
      expect(html).not.toContain('<b>.png"');
      expect(html).toContain("&quot;");
    });
  });

  it("pins to the newest revision in the gist's history", async () => {
    const { html } = await buildGistHtml(
      gist(
        [gistFile("notes.md", "![Chart](chart.png)")],
        [{ version: "a".repeat(40) }, { version: "b".repeat(40) }]
      )
    );
    expect(html).toContain(`src="${rawBase}/${"a".repeat(40)}/chart.png"`);
  });
});

describe("shouldRetryUnauthenticated (#1460)", () => {
  it("retries a rejected token, since everything we read is public", () => {
    expect(shouldRetryUnauthenticated(401, true)).toBe(true);
  });

  it("has nothing to retry when no token was sent", () => {
    expect(shouldRetryUnauthenticated(401, false)).toBe(false);
  });

  // The unauthenticated limit is the lower of the two, so a retry would spend the
  // shared per-IP budget only to fail again.
  it("does not retry a rate limit", () => {
    expect(shouldRetryUnauthenticated(403, true)).toBe(false);
    expect(shouldRetryUnauthenticated(429, true)).toBe(false);
  });

  it("does not retry a 404 or a server error", () => {
    expect(shouldRetryUnauthenticated(404, true)).toBe(false);
    expect(shouldRetryUnauthenticated(500, true)).toBe(false);
  });
});
