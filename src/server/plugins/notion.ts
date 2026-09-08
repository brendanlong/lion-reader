import type { UrlPlugin, SavedArticleContent, FetchedPage } from "./types";
import { fetchNotionPageBlocks } from "@/server/notion/api";
import { renderNotionPage } from "@/server/notion/render";
import { formatNotionId } from "@/server/notion/page-id";
import { usageLimitsConfig } from "@/server/config/env";
import { logger } from "@/lib/logger";

/**
 * Notion plugin: renders published Notion pages via Notion's internal page API.
 *
 * Why an API at all: a published Notion page — on `*.notion.site` or on a
 * customer's own domain — is a ~20 KB client-rendered shell (`<title>Notion`,
 * one empty `<p>`, no article text), so the generic fetch + Readability path
 * stores an empty article. Measured on handbook.sparai.org, 2026-09. The
 * official API (api.notion.com) only reads pages explicitly shared with an
 * integration, never arbitrary public pages, so this uses the web app's own
 * `loadPageChunk` endpoint (see `src/server/notion/api.ts`).
 *
 * That endpoint is unofficial, so the plugin declines on ANY failure —
 * including rate limiting, which other plugins rethrow — and the save
 * continues with the page as fetched. Rethrowing exists to keep a fallback
 * from re-requesting the host that just throttled us; here the fallback never
 * touches www.notion.so again: the shell either is already in hand (custom
 * domain) or comes from a `*.notion.site` host.
 *
 * Custom domains can't be matched by hostname, so the plugin also implements
 * `fetchContentFromPage`, claiming an already-fetched page only when the
 * document itself is Notion's shell (`<html class="notion-html" …>`) and names
 * its page id. DNS is no help — such domains resolve straight to Cloudflare.
 *
 * robots.txt (www.notion.so): `Allow: /` for `User-agent: *`; `/api/` is not
 * disallowed.
 */

/** Page URLs end in the bare id, after a `/` or the slug's trailing `-`. */
const PATH_ID_PATTERN = /(?:^|[/-])([0-9a-f]{32})\/?$/i;
/** The shell's `requiredRedirectMetadata` names the page being served. */
const SHELL_PAGE_ID_PATTERN =
  /"pageId":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/;
const CLASS_ATTRIBUTE_PATTERN = /\sclass="([^"]*)"/;
/** The markers sit in the shell's head; don't scan a whole 5 MB page for them. */
const SHELL_SCAN_BYTES = 65536;

/**
 * The page id a Notion URL points at, as a dashed UUID, or null if the URL has
 * none (a site's root page, marketing pages on notion.so/notion.com). A `?p=`
 * peek parameter — the page opened as a side panel — wins over the path.
 */
export function extractNotionPageId(url: URL): string | null {
  const peek = url.searchParams.get("p");
  if (peek) {
    const id = formatNotionId(peek);
    if (id) return id;
  }
  const match = PATH_ID_PATTERN.exec(url.pathname);
  return match ? formatNotionId(match[1]!) : null;
}

/**
 * Whether this document is Notion's page shell: its root `<html>` element
 * carries the `notion-html` class. Only the first `<html` tag is inspected —
 * a document has one root element, and this runs on every generic fetch, so
 * it must stay linear in the input.
 */
export function isNotionShell(html: string): boolean {
  const head = html.slice(0, SHELL_SCAN_BYTES);
  const start = head.indexOf("<html");
  if (start < 0) return false;
  const end = head.indexOf(">", start);
  const tag = head.slice(start, end < 0 ? undefined : end);
  const classes = CLASS_ATTRIBUTE_PATTERN.exec(tag)?.[1];
  return classes !== undefined && classes.split(/\s+/).includes("notion-html");
}

export function extractNotionPageIdFromShell(html: string): string | null {
  const match = SHELL_PAGE_ID_PATTERN.exec(html.slice(0, SHELL_SCAN_BYTES));
  return match ? match[1]!.toLowerCase() : null;
}

/** The page URL without tracking params, on the origin it was requested from. */
function canonicalNotionUrl(url: URL, pageId: string): string {
  const canonical = new URL(url.href);
  canonical.search = "";
  canonical.hash = "";
  const pathId = PATH_ID_PATTERN.exec(url.pathname)?.[1];
  if (!pathId || formatNotionId(pathId) !== pageId) {
    canonical.pathname = `/${pageId.replace(/-/g, "")}`;
  }
  return canonical.href;
}

async function fetchNotionArticle(pageId: string, url: URL): Promise<SavedArticleContent | null> {
  try {
    const blocks = await fetchNotionPageBlocks(pageId);
    const rendered = renderNotionPage(blocks, pageId, url, {
      maxHtmlLength: usageLimitsConfig.maxSavedArticleSizeBytes,
    });
    if (!rendered?.html) {
      logger.info("Notion page has no readable content (not published?)", {
        url: url.href,
        pageId,
      });
      return null;
    }
    return {
      html: rendered.html,
      title: rendered.title,
      canonicalUrl: canonicalNotionUrl(url, pageId),
    };
  } catch (error) {
    logger.warn("Notion page fetch failed, falling back to the page as fetched", {
      url: url.href,
      pageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export const notionPlugin: UrlPlugin = {
  name: "notion",
  hosts: ["notion.so", "www.notion.so", "notion.com", "www.notion.com", "*.notion.site"],

  matchUrl(url: URL): boolean {
    return extractNotionPageId(url) !== null;
  },

  capabilities: {
    savedArticle: {
      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        const pageId = extractNotionPageId(url);
        return pageId ? fetchNotionArticle(pageId, url) : null;
      },

      async fetchContentFromPage({ html, url }: FetchedPage): Promise<SavedArticleContent | null> {
        if (!isNotionShell(html)) return null;
        const pageId = extractNotionPageIdFromShell(html) ?? extractNotionPageId(url);
        if (!pageId) {
          logger.debug("Notion shell without a page id (site root?), leaving it alone", {
            url: url.href,
          });
          return null;
        }
        return fetchNotionArticle(pageId, url);
      },

      skipReadability: true,
    },
  },
};
