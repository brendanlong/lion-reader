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
