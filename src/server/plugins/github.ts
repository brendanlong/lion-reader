import type { UrlPlugin, SavedArticleContent } from "./types";
import { logger } from "@/lib/logger";
import { USER_AGENT } from "@/server/http/user-agent";
import { githubConfig } from "@/server/config/env";
import { marked } from "marked";
import { extractAndStripTitleHeader } from "@/server/html/strip-title-header";

// ============================================================================
// Types
// ============================================================================

type GitHubUrlType =
  | { type: "gist"; gistId: string; filename?: string }
  | { type: "repo-root"; owner: string; repo: string }
  | { type: "blob"; owner: string; repo: string; ref: string; path: string }
  | { type: "raw"; owner: string; repo: string; ref: string; path: string };

interface GistFile {
  filename: string;
  language: string | null;
  content: string;
}

interface GistResponse {
  id: string;
  description: string | null;
  owner?: { login: string } | null;
  files: Record<string, GistFile>;
  created_at: string;
  updated_at: string;
}

interface ContentsResponse {
  name: string;
  path: string;
  content?: string; // base64 encoded
  encoding?: string;
  download_url: string | null;
}

// ============================================================================
// URL Parsing
// ============================================================================

/**
 * Parse a GitHub URL into its component type.
 */
export function parseGitHubUrl(url: URL): GitHubUrlType | null {
  const hostname = url.hostname.toLowerCase();

  // Gist URLs: gist.github.com/{user}/{gist_id} or gist.github.com/{gist_id}
  if (hostname === "gist.github.com") {
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 0) {
      return null;
    }

    // Extract filename from fragment if present
    // GitHub normalizes: "README.md" → "file-readme-md"
    const filename = parseGistFilenameFromFragment(url.hash);

    // gist.github.com/{gist_id} (anonymous gist)
    if (parts.length === 1) {
      return { type: "gist", gistId: parts[0], filename };
    }

    // gist.github.com/{user}/{gist_id}
    if (parts.length >= 2) {
      return { type: "gist", gistId: parts[1], filename };
    }

    return null;
  }

  // Raw URLs: raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
  if (hostname === "raw.githubusercontent.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 4) {
      return null;
    }

    const [owner, repo, ref, ...pathParts] = parts;
    return {
      type: "raw",
      owner,
      repo,
      ref,
      path: pathParts.join("/"),
    };
  }

  // GitHub.com URLs
  if (hostname === "github.com" || hostname === "www.github.com") {
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length < 2) {
      return null;
    }

    const [owner, repo, ...rest] = parts;

    // Repo root: github.com/{owner}/{repo}
    if (rest.length === 0) {
      return { type: "repo-root", owner, repo };
    }

    // Blob view: github.com/{owner}/{repo}/blob/{ref}/{path}
    if (rest[0] === "blob" && rest.length >= 3) {
      const [, ref, ...pathParts] = rest;
      return {
        type: "blob",
        owner,
        repo,
        ref,
        path: pathParts.join("/"),
      };
    }

    return null;
  }

  return null;
}

/**
 * Parse filename from GitHub gist URL fragment.
 * GitHub normalizes filenames: "README.md" → "file-readme-md"
 */
export function parseGistFilenameFromFragment(hash: string): string | undefined {
  if (!hash || !hash.startsWith("#file-")) {
    return undefined;
  }

  // Remove "#file-" prefix
  const normalized = hash.slice(6);

  // GitHub replaces dots and special chars with dashes, lowercases everything
  // We can't perfectly reverse this, but we can return the normalized form
  // and match against normalized versions of actual filenames
  return normalized;
}

/**
 * Normalize a filename to match GitHub's fragment format.
 * "README.md" → "readme-md"
 */
export function normalizeFilenameForFragment(filename: string): string {
  return filename.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// ============================================================================
// API Fetching
// ============================================================================

/**
 * Build headers for GitHub API requests.
 */
function getApiHeaders(): HeadersInit {
  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (githubConfig.apiToken) {
    headers.Authorization = `Bearer ${githubConfig.apiToken}`;
  }

  return headers;
}

/**
 * Fetch a gist by ID.
 */
async function fetchGist(gistId: string): Promise<GistResponse | null> {
  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: getApiHeaders(),
  });

  if (!response.ok) {
    if (response.status === 404) {
      logger.debug("Gist not found", { gistId });
      return null;
    }
    if (response.status === 403 || response.status === 429) {
      logger.warn("GitHub API rate limited", { gistId, status: response.status });
      return null;
    }
    logger.warn("Failed to fetch gist", { gistId, status: response.status });
    return null;
  }

  return (await response.json()) as GistResponse;
}

/**
 * Fetch file contents from a repo via the Contents API.
 */
async function fetchRepoContents(
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<ContentsResponse | null> {
  let url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  if (ref) {
    url += `?ref=${encodeURIComponent(ref)}`;
  }

  const response = await fetch(url, {
    headers: getApiHeaders(),
  });

  if (!response.ok) {
    if (response.status === 404) {
      logger.debug("Repo content not found", { owner, repo, path, ref });
      return null;
    }
    if (response.status === 403 || response.status === 429) {
      logger.warn("GitHub API rate limited", { owner, repo, status: response.status });
      return null;
    }
    logger.warn("Failed to fetch repo content", { owner, repo, path, status: response.status });
    return null;
  }

  return (await response.json()) as ContentsResponse;
}

/**
 * Fetch raw file content directly.
 */
async function fetchRawContent(rawUrl: string): Promise<string | null> {
  const response = await fetch(rawUrl, {
    headers: {
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    logger.debug("Failed to fetch raw content", { url: rawUrl, status: response.status });
    return null;
  }

  return await response.text();
}

/**
 * Try to fetch README from a repo root.
 * Tries common README variants in order.
 */
async function fetchReadme(
  owner: string,
  repo: string
): Promise<{ content: string; filename: string } | null> {
  const readmeVariants = ["README.md", "readme.md", "Readme.md", "README", "readme", "README.txt"];

  for (const variant of readmeVariants) {
    const contents = await fetchRepoContents(owner, repo, variant);
    if (contents?.content && contents.encoding === "base64") {
      const content = Buffer.from(contents.content, "base64").toString("utf-8");
      return { content, filename: variant };
    }
  }

  return null;
}

// ============================================================================
// Content Processing
// ============================================================================

/**
 * Check if a filename indicates Markdown content.
 */
export function isMarkdownFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower === "readme";
}

/**
 * Check if a filename indicates HTML content.
 */
export function isHtmlFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

/**
 * Check if content looks like Markdown based on the API language field.
 */
function isMarkdownLanguage(language: string | null): boolean {
  if (!language) return false;
  return language.toLowerCase() === "markdown";
}

/**
 * Convert Markdown content to HTML and extract title from first header.
 * Returns both the cleaned HTML (with title header stripped) and the extracted title.
 */
function processMarkdownContent(content: string): { html: string; title: string | null } {
  const html = marked.parse(content, { async: false }) as string;
  const { title, content: cleanedHtml } = extractAndStripTitleHeader(html);
  return { html: cleanedHtml, title };
}

/**
 * Wrap code in a styled pre block.
 */
function codeToHtml(content: string, language?: string): string {
  const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const langClass = language ? ` class="language-${language.toLowerCase()}"` : "";
  return `<pre><code${langClass}>${escaped}</code></pre>`;
}

/**
 * Process a single file's content into HTML.
 * For markdown files, also extracts the title from the first header.
 */
function processFileContent(
  content: string,
  filename: string,
  language: string | null
): { html: string; extractedTitle: string | null } {
  if (isMarkdownFile(filename) || isMarkdownLanguage(language)) {
    const { html, title } = processMarkdownContent(content);
    return { html, extractedTitle: title };
  }

  if (isHtmlFile(filename)) {
    return { html: content, extractedTitle: null };
  }

  // For other files, wrap in code block
  return { html: codeToHtml(content, language ?? undefined), extractedTitle: null };
}

/**
 * Build HTML from a gist with multiple files.
 */
function buildGistHtml(
  gist: GistResponse,
  targetFilename?: string
): { html: string; title: string | null } {
  const files = Object.values(gist.files).sort((a, b) => a.filename.localeCompare(b.filename));

  if (files.length === 0) {
    return { html: "<p>Empty gist</p>", title: null };
  }

  // If a specific file is requested, find it
  if (targetFilename) {
    const normalizedTarget = targetFilename.toLowerCase();
    const matchedFile = files.find(
      (f) =>
        normalizeFilenameForFragment(f.filename) === normalizedTarget ||
        f.filename.toLowerCase() === normalizedTarget
    );

    if (matchedFile) {
      const { html, extractedTitle } = processFileContent(
        matchedFile.content,
        matchedFile.filename,
        matchedFile.language
      );
      // Use extracted title from markdown, fall back to filename
      return { html, title: extractedTitle || matchedFile.filename };
    }
  }

  // Single file: return it directly
  if (files.length === 1) {
    const file = files[0];
    const { html, extractedTitle } = processFileContent(file.content, file.filename, file.language);
    // Use extracted title from markdown, fall back to filename
    return { html, title: extractedTitle || file.filename };
  }

  // Multiple files: concatenate with headers
  const parts: string[] = [];
  for (const file of files) {
    parts.push(`<h2>${escapeHtml(file.filename)}</h2>`);
    const { html } = processFileContent(file.content, file.filename, file.language);
    parts.push(html);
  }

  return { html: parts.join("\n"), title: null };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================================
// Plugin Implementation
// ============================================================================

async function fetchGitHubContent(url: URL): Promise<SavedArticleContent | null> {
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return null;
  }

  logger.debug("Fetching GitHub content", { url: url.href, type: parsed.type });

  switch (parsed.type) {
    case "gist": {
      const gist = await fetchGist(parsed.gistId);
      if (!gist) {
        return null;
      }

      const { html, title: fileTitle } = buildGistHtml(gist, parsed.filename);

      // Build a nice title
      let title = fileTitle || gist.description;
      if (!title) {
        title = `Gist ${parsed.gistId}`;
      }

      return {
        html,
        title,
        author: gist.owner?.login ?? null,
        publishedAt: gist.created_at ? new Date(gist.created_at) : null,
        canonicalUrl: `https://gist.github.com/${gist.owner?.login ?? ""}/${gist.id}`,
      };
    }

    case "repo-root": {
      const readme = await fetchReadme(parsed.owner, parsed.repo);
      if (!readme) {
        logger.debug("No README found for repo", { owner: parsed.owner, repo: parsed.repo });
        return null;
      }

      const { html, extractedTitle } = processFileContent(readme.content, readme.filename, null);

      return {
        html,
        // Use extracted title from README, fall back to repo name
        title: extractedTitle || `${parsed.owner}/${parsed.repo}`,
        author: parsed.owner,
        publishedAt: null,
        canonicalUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
      };
    }

    case "blob": {
      const contents = await fetchRepoContents(parsed.owner, parsed.repo, parsed.path, parsed.ref);
      const filename = parsed.path.split("/").pop() ?? parsed.path;

      if (!contents?.content || contents.encoding !== "base64") {
        // Try raw URL as fallback
        const rawUrl = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.ref}/${parsed.path}`;
        const rawContent = await fetchRawContent(rawUrl);
        if (!rawContent) {
          return null;
        }

        const { html, extractedTitle } = processFileContent(rawContent, parsed.path, null);
        return {
          html,
          title: extractedTitle || filename,
          author: parsed.owner,
          publishedAt: null,
          canonicalUrl: `https://github.com/${parsed.owner}/${parsed.repo}/blob/${parsed.ref}/${parsed.path}`,
        };
      }

      const content = Buffer.from(contents.content, "base64").toString("utf-8");
      const { html, extractedTitle } = processFileContent(content, parsed.path, null);

      return {
        html,
        title: extractedTitle || filename,
        author: parsed.owner,
        publishedAt: null,
        canonicalUrl: `https://github.com/${parsed.owner}/${parsed.repo}/blob/${parsed.ref}/${parsed.path}`,
      };
    }

    case "raw": {
      const rawUrl = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.ref}/${parsed.path}`;
      const content = await fetchRawContent(rawUrl);
      if (!content) {
        return null;
      }

      const filename = parsed.path.split("/").pop() ?? parsed.path;
      const { html, extractedTitle } = processFileContent(content, parsed.path, null);

      return {
        html,
        title: extractedTitle || filename,
        author: parsed.owner,
        publishedAt: null,
        canonicalUrl: `https://github.com/${parsed.owner}/${parsed.repo}/blob/${parsed.ref}/${parsed.path}`,
      };
    }
  }
}

/**
 * GitHub plugin for fetching gists and repository files.
 *
 * Provides capability for:
 * - SavedArticle: Fetch gists and repo files, converting Markdown to HTML
 *
 * Supported URL patterns:
 * - gist.github.com/{user}/{gist_id} - Gist pages
 * - gist.github.com/{user}/{gist_id}#file-readme-md - Specific file in gist
 * - github.com/{owner}/{repo} - Repo root (fetches README)
 * - github.com/{owner}/{repo}/blob/{ref}/{path} - Specific file
 * - raw.githubusercontent.com/{owner}/{repo}/{ref}/{path} - Raw file
 */
export const githubPlugin: UrlPlugin = {
  name: "github",
  hosts: ["gist.github.com", "github.com", "www.github.com", "raw.githubusercontent.com"],

  matchUrl(url: URL): boolean {
    const parsed = parseGitHubUrl(url);
    return parsed !== null;
  },

  capabilities: {
    savedArticle: {
      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        try {
          return await fetchGitHubContent(url);
        } catch (error) {
          logger.warn("Failed to fetch GitHub content", {
            url: url.href,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },

      skipReadability: true, // Our Markdown conversion produces clean HTML
      siteName: "GitHub",
    },
  },
};
