import type { UrlPlugin, SavedArticleContent } from "./types";
import { logger } from "@/lib/logger";
import { USER_AGENT } from "@/server/http/user-agent";
import { readResponseWithSizeLimit } from "@/server/http/fetch";
import { fetchWithSsrfProtection } from "@/server/http/ssrf";
import { escapeHtml } from "@/server/http/html";
import { githubConfig, usageLimitsConfig } from "@/server/config/env";
import { processMarkdown } from "@/server/markdown";
import { absolutizeUrls } from "@/server/feed/content-cleaner";

// ============================================================================
// Types
// ============================================================================

type GitHubUrlType =
  | { type: "gist"; gistId: string; filename?: string }
  | { type: "repo-root"; owner: string; repo: string }
  | { type: "blob"; owner: string; repo: string; ref: string; path: string }
  | { type: "raw"; owner: string; repo: string; ref: string; path: string };

export interface GistFile {
  filename: string;
  language: string | null;
  content: string;
  /** `https://gist.githubusercontent.com/{user}/{id}/raw/{sha}/{filename}`. */
  raw_url: string;
  /** Media type GitHub detected, e.g. `text/markdown`, `image/png`. */
  type: string;
}

export interface GistResponse {
  id: string;
  description: string | null;
  owner?: { login: string } | null;
  files: Record<string, GistFile>;
  /** Revisions, newest first. */
  history?: { version: string }[];
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
 * Split the `{ref}/{path}` tail of a blob or raw URL.
 *
 * A ref may contain slashes (`feature/x`), so the boundary is ambiguous in
 * general and we take the first segment — right for the common `main`-style ref.
 * The fully-qualified `refs/heads/…` / `refs/tags/…` forms are unambiguous
 * though, and they're what GitHub's "Raw" button emits today, so absorb those
 * three segments. Getting this right matters beyond re-joining `${ref}/${path}`:
 * `absolutizeGitHubUrls` needs the ref *alone* to build the repo root.
 */
function splitRefAndPath(segments: string[]): { ref: string; path: string } {
  const qualified =
    segments.length >= 3 && segments[0] === "refs" && ["heads", "tags"].includes(segments[1]);
  const refLength = qualified ? 3 : 1;
  return {
    ref: segments.slice(0, refLength).join("/"),
    path: segments.slice(refLength).join("/"),
  };
}

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

    const [owner, repo, ...refAndPath] = parts;
    return {
      type: "raw",
      owner,
      repo,
      ...splitRefAndPath(refAndPath),
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
      return {
        type: "blob",
        owner,
        repo,
        ...splitRefAndPath(rest.slice(1)),
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
 * Normalize a filename to the fragment GitHub anchors that file's section of a
 * gist page under: `README.md` → `readme-md`, so the anchor is `#file-readme-md`.
 *
 * This is Rails' `parameterize`, which is what GitHub runs the filename through
 * (each rule below verified against live gist pages): transliterate to ASCII
 * (`datenschutzerklärung.md` → `datenschutzerklarung-md`), lowercase, replace
 * runs of anything outside `[a-z0-9_-]` with a single dash, and trim dashes off
 * the ends. **Underscores survive** (`_Summary.md` → `_summary-md`): dashing
 * them out leaves a `#file-…` URL copied from GitHub matching no file, and gist
 * filenames are full of them (`agent_patch.diff`).
 *
 * Both directions run through here — we emit these fragments for sibling links
 * (`absolutizeGistUrls`) and match a saved URL's fragment back to a file
 * (`buildGistHtml`) — so the two stay consistent even where transliteration
 * can't match Rails exactly (it folds diacritics, not `ß`/`ø`-style mappings).
 */
export function normalizeFilenameForFragment(filename: string): string {
  return filename
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// ============================================================================
// API Fetching
// ============================================================================

/**
 * Build headers for GitHub API requests.
 */
function getApiHeaders(authenticated = true): HeadersInit {
  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (authenticated && githubConfig.apiToken) {
    headers.Authorization = `Bearer ${githubConfig.apiToken}`;
  }

  return headers;
}

/**
 * Whether a rejected response is worth retrying without our credentials.
 *
 * Only a 401 — GitHub rejecting the token itself. A 403/429 is a rate limit, and
 * the unauthenticated limit is the *lower* of the two, so retrying there would
 * burn the shared per-IP budget to fail again.
 */
export function shouldRetryUnauthenticated(status: number, hasToken: boolean): boolean {
  return status === 401 && hasToken;
}

/**
 * GET a GitHub API URL, retrying once without credentials if GitHub rejects them.
 *
 * Everything we read here is public, so the token only buys rate limit (5000/hr
 * vs 60/hr per IP) — an expired one must not leave us worse off than no token at
 * all. Untreated, a 401 makes the caller return null, and the saved-article path
 * turns that null into a scrape of GitHub's HTML page: an article body of page
 * chrome that reads as a bug in the reader (#1460). `fetchRawContent` already
 * reads the raw host unauthenticated, which is the only reason `blob` URLs kept
 * working through a bad token while gists and repo roots silently degraded.
 */
async function fetchGitHubApi(url: string): Promise<Response> {
  const response = await fetchWithSsrfProtection(url, { headers: getApiHeaders() });

  if (!shouldRetryUnauthenticated(response.status, Boolean(githubConfig.apiToken))) {
    return response;
  }

  // Only an operator can fix this, so it's logged every attempt, to reach Sentry.
  logger.error("GitHub API rejected our credentials; check GITHUB_API_TOKEN", { url });
  // We never read a rejection's body, so let go of the socket before retrying.
  await response.body?.cancel();

  return fetchWithSsrfProtection(url, { headers: getApiHeaders(false) });
}

/**
 * Log a GitHub API response we can't use, at the level its cause deserves. A 401
 * is logged by `fetchGitHubApi`, which is where the retry it triggers lives.
 */
function logApiFailure(status: number, context: Record<string, string | undefined>): void {
  if (status === 403 || status === 429) {
    logger.warn("GitHub API rate limited", { status, ...context });
  } else {
    logger.warn("GitHub API request failed", { status, ...context });
  }
}

/**
 * Fetch a gist by ID.
 */
async function fetchGist(gistId: string): Promise<GistResponse | null> {
  const response = await fetchGitHubApi(`https://api.github.com/gists/${gistId}`);

  if (!response.ok) {
    if (response.status === 404) {
      logger.debug("Gist not found", { gistId });
      return null;
    }
    logApiFailure(response.status, { gistId });
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

  const response = await fetchGitHubApi(url);

  if (!response.ok) {
    if (response.status === 404) {
      logger.debug("Repo content not found", { owner, repo, path, ref });
      return null;
    }
    logApiFailure(response.status, { owner, repo, path });
    return null;
  }

  return (await response.json()) as ContentsResponse;
}

/**
 * Timeout for raw file fetches (30 seconds).
 */
const RAW_FETCH_TIMEOUT_MS = 30000;

/**
 * Fetch raw file content directly.
 *
 * The host is fixed (raw.githubusercontent.com), but the path is user-chosen,
 * so the read is size-limited and time-limited to avoid OOM/hangs on large files.
 */
async function fetchRawContent(rawUrl: string): Promise<string | null> {
  try {
    const response = await fetchWithSsrfProtection(rawUrl, {
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(RAW_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.debug("Failed to fetch raw content", { url: rawUrl, status: response.status });
      return null;
    }

    return await readResponseWithSizeLimit(
      response,
      usageLimitsConfig.maxSavedArticleSizeBytes,
      rawUrl
    );
  } catch (error) {
    logger.warn("Failed to fetch raw content", {
      url: rawUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
 * Whether a media type names bytes no one wants to read as text. Deliberately a
 * list of what we can name: an unrecognized `application/*` is far more often
 * source code (`application/x-python`, `application/json`) than a binary, and
 * rendering that as text is the better guess.
 */
function isBinaryMediaType(type: string): boolean {
  return (
    ["image/", "audio/", "video/", "font/"].some((prefix) => type.startsWith(prefix)) ||
    [
      "application/pdf",
      "application/zip",
      "application/gzip",
      "application/mp4",
      "application/octet-stream",
    ].includes(type)
  );
}

/**
 * Check if content looks like Markdown based on the API language field.
 */
function isMarkdownLanguage(language: string | null): boolean {
  if (!language) return false;
  return language.toLowerCase() === "markdown";
}

/**
 * A file's location in a repo, used to resolve the relative URLs in it.
 * `ref` defaults to `HEAD` (accepted by both github.com and
 * raw.githubusercontent.com) for the repo-root README, which we fetch without one.
 */
export interface RepoFileLocation {
  kind: "repo";
  owner: string;
  repo: string;
  ref?: string;
  path: string;
}

/** A gist file's location, used to resolve the relative URLs in it. */
export interface GistFileLocation {
  kind: "gist";
  /**
   * The file's own `raw_url` from the gists API, which the `{user}/{id}` the
   * gist is served under is read back out of. Taking GitHub's URL avoids
   * depending on `owner`, which the API leaves null for an ownerless gist —
   * and the user segment is load-bearing (a wrong one 404s).
   */
  rawUrl: string;
  /** The gist's current commit sha, when the response carried its history. */
  revision?: string;
  /**
   * Every filename in the gist, which is what makes a relative link a *sibling*
   * link — see `absolutizeGistUrls`. Omitted where a link is meant to reach the
   * file's bytes no matter what.
   */
  filenames?: string[];
}

/** Where a rendered file came from, which is what its relative URLs resolve to. */
export type FileLocation = RepoFileLocation | GistFileLocation;

/**
 * Absolutize the relative URLs in a rendered repo file against GitHub's *two*
 * bases: embedded files (`src`) resolve to raw.githubusercontent.com, which
 * serves the bytes, while links (`href`) resolve to the github.com blob view,
 * which serves a page a reader can actually follow. This has to happen here
 * rather than in the generic single-base absolutizer downstream, which resolves
 * everything against the article URL — that turns `images/foo.png` into a
 * `github.com/…/blob/…/images/foo.png` HTML page and renders a broken image.
 *
 * Both bases are the file's own URL, so paths resolve relative to its directory
 * the way GitHub renders them. GitHub also reads a leading slash
 * (`/docs/logo.png`) as relative to the *repo* root rather than the origin root
 * that URL semantics would give, so each base gets a matching root base at the
 * repo's ref (#1423).
 */
function absolutizeGitHubUrls(html: string, file: RepoFileLocation): string {
  const { owner, repo, ref = "HEAD", path } = file;
  const blobRoot = `https://github.com/${owner}/${repo}/blob/${ref}/`;
  const rawRoot = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/`;
  return absolutizeUrls(html, `${blobRoot}${path}`, {
    rootBaseUrl: blobRoot,
    media: { baseUrl: `${rawRoot}${path}`, rootBaseUrl: rawRoot },
  });
}

/** A git object name, which is all we'll put in a URL path we build. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * The `{user}/{id}` a gist is served under, read back out of one of its files'
 * `raw_url`. Null if that URL isn't the shape we know — every URL in the
 * document resolves against a base built from this, so an unrecognized one is
 * left alone rather than guessed at.
 */
function parseGistRawUrl(rawUrl: string): { user: string; id: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const [user, id, raw] = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname !== "gist.githubusercontent.com" || raw !== "raw") {
    logger.debug("Unexpected gist raw URL, leaving relative URLs alone", { rawUrl });
    return null;
  }

  return { user, id };
}

/**
 * The directory a gist's files are served under, at `revision` when we know it:
 * `https://gist.githubusercontent.com/{user}/{id}/raw/{revision}/`.
 *
 * The sha already in a `raw_url` (`…/raw/{sha}/{filename}`) is *not* that
 * revision and must be dropped: it names the file's own **blob**, and the
 * filename after it is then ignored, so `…/raw/{sha-of-notes.md}/chart.png`
 * serves notes.md's bytes under the sibling's name. The gist's commit sha
 * (`history[0].version`, what GitHub's own links use) does honor the filename,
 * and pins the article to the revision we rendered; without one the sha-less form
 * tracks the gist's current revision. Both 404 for a file that isn't there
 * (verified against the live host).
 */
function gistRawBase(gist: { user: string; id: string }, revision?: string): string {
  const pinned = revision && SHA_PATTERN.test(revision) ? `${revision}/` : "";
  return `https://gist.githubusercontent.com/${gist.user}/${gist.id}/raw/${pinned}`;
}

/**
 * Redirect a link that resolved to one of the gist's *own* files off the raw
 * host and onto that file's anchor on the gist page
 * (`gist.github.com/{user}/{id}#file-…`), which is what GitHub's own rendering
 * of a relative link produces (#1459). Raw serves the file either way, but as
 * `text/plain` under `nosniff` and a CSP sandbox — so a reader following
 * `[Setup](setup.md)` lands on unrendered source. It's the same reasoning that
 * sends a repo file's links to the blob view (`absolutizeGitHubUrls`), and the
 * anchor round-trips: `parseGitHubUrl` parses it back, so the link is re-savable
 * in Lion Reader.
 *
 * Only links, never `src` — GitHub gives an embedded image the same anchor,
 * which is an `<img>` pointing at an HTML page, i.e. its own rendering of a
 * sibling image in a gist is broken. And only for a reference naming a file the
 * gist actually has, since nothing else has an anchor to land on; the match is
 * on the normalized fragment, so a link written `readme.md` for `README.md`
 * reaches the same anchor GitHub emits. A reference carrying a query or its own
 * fragment keeps the raw URL rather than silently losing it.
 */
function gistSiblingLinkRewriter(
  gist: { user: string; id: string },
  rawBase: string,
  filenames: string[]
): (url: string) => string {
  const base = new URL(rawBase);
  const fragments = new Set(filenames.map(normalizeFilenameForFragment));

  return (url) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      // Not absolute: a same-document fragment or other value resolution left alone.
      return url;
    }

    if (
      target.origin !== base.origin ||
      !target.pathname.startsWith(base.pathname) ||
      target.search ||
      target.hash
    ) {
      return url;
    }

    let filename: string;
    try {
      filename = decodeURIComponent(target.pathname.slice(base.pathname.length));
    } catch {
      return url;
    }

    const fragment = normalizeFilenameForFragment(filename);
    return fragments.has(fragment)
      ? `https://gist.github.com/${gist.user}/${gist.id}#file-${fragment}`
      : url;
  };
}

/**
 * Absolutize the relative URLs in a rendered gist file against the raw host that
 * serves the gist's files, so a reference to a sibling file (`chart.png`)
 * resolves to that file. Without this the reference falls through to the generic
 * single-base absolutizer downstream, which resolves it against
 * `gist.github.com/{user}/{id}` — the gist's HTML page, so an image renders
 * broken (#1424).
 *
 * Unlike a repo file, whose two bases split embeds from links (see
 * `absolutizeGitHubUrls`), everything here resolves against the one raw base —
 * links then get a second say, `gistSiblingLinkRewriter`, because the page a
 * link should reach isn't expressible as a base.
 *
 * A gist's files are a flat list, so a leading slash can only mean a sibling too:
 * the root base is the same base.
 */
function absolutizeGistUrls(html: string, file: GistFileLocation): string {
  const gist = parseGistRawUrl(file.rawUrl);
  if (!gist) {
    return html;
  }

  const base = gistRawBase(gist, file.revision);
  return absolutizeUrls(html, base, {
    rootBaseUrl: base,
    rewriteHref: file.filenames?.length
      ? gistSiblingLinkRewriter(gist, base, file.filenames)
      : undefined,
  });
}

/**
 * Wrap code in a styled pre block.
 */
function codeToHtml(content: string, language?: string): string {
  const escaped = escapeHtml(content);

  const langClass = language ? ` class="language-${escapeHtml(language.toLowerCase())}"` : "";
  return `<pre><code${langClass}>${escaped}</code></pre>`;
}

/** A repo/gist file rendered to HTML, plus whatever metadata it declared. */
interface ProcessedRepoFile {
  html: string;
  /** Frontmatter title, else the leading heading (which is stripped from html). */
  title: string | null;
  /** Frontmatter author, when the file declares one. */
  author: string | null;
  /** Frontmatter description, when the file declares one. */
  excerpt: string | null;
}

/**
 * Process a single file's content into HTML.
 *
 * Markdown goes through `processMarkdown`, so a repo file gets exactly the dialect
 * an upload does. Note that includes `$…$` math, which GitHub itself doesn't
 * render — harmless in practice, since the standard delimiters don't fire on
 * prose (`costs $5 and $10` stays text) and there's a test for that.
 *
 * `location` is the repo or gist file the content came from, so its relative URLs
 * can be resolved GitHub's way — the two hosts differ, so see the two
 * absolutizers for what each resolves to.
 */
export async function processFileContent(
  content: string,
  filename: string,
  language: string | null,
  location: FileLocation
): Promise<ProcessedRepoFile> {
  const absolutize = (html: string): string =>
    location.kind === "gist"
      ? absolutizeGistUrls(html, location)
      : absolutizeGitHubUrls(html, location);

  if (isMarkdownFile(filename) || isMarkdownLanguage(language)) {
    const { html, title, summary, author } = await processMarkdown(content);
    return { html: absolutize(html), title, author, excerpt: summary };
  }

  if (isHtmlFile(filename)) {
    return { html: absolutize(content), title: null, author: null, excerpt: null };
  }

  // For other files, wrap in code block. The content is HTML-escaped, so there
  // are no URL attributes left to absolutize.
  return {
    html: codeToHtml(content, language ?? undefined),
    title: null,
    author: null,
    excerpt: null,
  };
}

/**
 * Build HTML from a gist with multiple files. Metadata a single file declared in
 * frontmatter is propagated; a concatenation of several has no one author/excerpt.
 */
export async function buildGistHtml(
  gist: GistResponse,
  targetFilename?: string
): Promise<ProcessedRepoFile> {
  const files = Object.values(gist.files).sort((a, b) => a.filename.localeCompare(b.filename));

  if (files.length === 0) {
    return { html: "<p>Empty gist</p>", title: null, author: null, excerpt: null };
  }

  // Newest first, so this is the revision whose contents we're rendering.
  const revision = gist.history?.[0]?.version;
  const filenames = files.map((f) => f.filename);
  const locate = (file: GistFile): GistFileLocation => ({
    kind: "gist",
    rawUrl: file.raw_url,
    revision,
    filenames,
  });

  /**
   * A gist holds whatever a git repo can, and the API returns a binary file's
   * bytes base64-encoded in `content` — which the code-block fallback renders as
   * screenfuls of base64. `type` is what GitHub knows about the file, so
   * classify from it: an image becomes an image, any other binary a link to
   * itself. Both are written as a *relative* reference so `absolutizeGistUrls`
   * resolves them against the raw host the way a reference inside a file
   * resolves, rather than duplicating that URL construction here.
   */
  const renderFile = async (file: GistFile): Promise<ProcessedRepoFile> => {
    const name = escapeHtml(file.filename);
    const empty = { title: null, author: null, excerpt: null };

    if (file.type.startsWith("image/")) {
      return {
        html: absolutizeGistUrls(`<img src="${name}" alt="${name}">`, locate(file)),
        ...empty,
      };
    }
    if (isBinaryMediaType(file.type)) {
      return {
        // No `filenames`: this link stands in for the file itself, so it has to
        // reach the bytes. It's the one place the sibling-link rewrite would be
        // a step backwards — the gist page renders a binary's section, not the
        // file, and there's nothing else here for the reader to click.
        html: absolutizeGistUrls(`<p><a href="${name}">${name}</a></p>`, {
          ...locate(file),
          filenames: undefined,
        }),
        ...empty,
      };
    }

    return processFileContent(file.content, file.filename, file.language, locate(file));
  };

  // If a specific file is requested, find it
  if (targetFilename) {
    const normalizedTarget = targetFilename.toLowerCase();
    const matchedFile = files.find(
      (f) =>
        normalizeFilenameForFragment(f.filename) === normalizedTarget ||
        f.filename.toLowerCase() === normalizedTarget
    );

    if (matchedFile) {
      const file = await renderFile(matchedFile);
      // Use extracted title from markdown, fall back to filename
      return { ...file, title: file.title || matchedFile.filename };
    }
  }

  // Single file: return it directly
  if (files.length === 1) {
    const only = files[0];
    const file = await renderFile(only);
    // Use extracted title from markdown, fall back to filename
    return { ...file, title: file.title || only.filename };
  }

  // Multiple files: concatenate with headers
  const parts: string[] = [];
  for (const file of files) {
    parts.push(`<h2>${escapeHtml(file.filename)}</h2>`);
    const { html } = await renderFile(file);
    parts.push(html);
  }

  return { html: parts.join("\n"), title: null, author: null, excerpt: null };
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

      const file = await buildGistHtml(gist, parsed.filename);

      // Build a nice title
      let title = file.title || gist.description;
      if (!title) {
        title = `Gist ${parsed.gistId}`;
      }

      return {
        html: file.html,
        title,
        excerpt: file.excerpt,
        // A frontmatter byline is more specific than "whoever owns the gist".
        author: file.author ?? gist.owner?.login ?? null,
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

      const file = await processFileContent(readme.content, readme.filename, null, {
        kind: "repo",
        owner: parsed.owner,
        repo: parsed.repo,
        path: readme.filename,
      });
      // Use extracted title from README, fall back to repo name
      const title = file.title || `${parsed.owner}/${parsed.repo}`;

      return {
        html: file.html,
        title,
        excerpt: file.excerpt,
        author: file.author ?? parsed.owner,
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

        const file = await processFileContent(rawContent, parsed.path, null, {
          kind: "repo",
          ...parsed,
        });
        const title = file.title || filename;
        return {
          html: file.html,
          title,
          excerpt: file.excerpt,
          author: file.author ?? parsed.owner,
          publishedAt: null,
          canonicalUrl: `https://github.com/${parsed.owner}/${parsed.repo}/blob/${parsed.ref}/${parsed.path}`,
        };
      }

      const content = Buffer.from(contents.content, "base64").toString("utf-8");
      const file = await processFileContent(content, parsed.path, null, {
        kind: "repo",
        ...parsed,
      });
      const title = file.title || filename;

      return {
        html: file.html,
        title,
        excerpt: file.excerpt,
        author: file.author ?? parsed.owner,
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
      const file = await processFileContent(content, parsed.path, null, {
        kind: "repo",
        ...parsed,
      });
      const title = file.title || filename;

      return {
        html: file.html,
        title,
        excerpt: file.excerpt,
        author: file.author ?? parsed.owner,
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
