import { fetchHtmlPage, HttpFetchError } from "@/server/http/fetch";
import { logger } from "@/lib/logger";

/** A fetched page, plus the URL it ended up at after redirects. */
interface PluginPage {
  html: string;
  finalUrl: string;
}

interface FetchPluginPageOptions {
  /**
   * Treat a 404 as an ordinary outcome and log it at debug rather than warn.
   *
   * For a plugin that probes one of several representations of the same thing
   * (arXiv's HTML render, which only exists for papers submitted as TeX since
   * late 2023), a miss is the common case, not a fault worth a warning.
   */
  notFoundIsExpected?: boolean;
}

/**
 * Fetch a page on behalf of a plugin whose only source is the public HTML
 * (LinkedIn, Threads, arXiv).
 *
 * Returns null when the page couldn't be fetched or wasn't HTML, so the plugin
 * returns null in turn and the save falls back to normal handling. That is the
 * right default here: these sources block, auth-wall, and change markup
 * routinely, and none of it should fail the save.
 *
 * **Rate limiting is the exception and is rethrown.** Falling back would
 * immediately re-request the very host that just throttled us; `saveArticle`'s
 * `acquireArticleContent` catches it and surfaces `upstreamRateLimited`
 * instead. `lesswrong.ts` rethrows for the same reason. A caller that fetches
 * several pages concurrently should hold the rejection until it knows it has no
 * content — the point is to avoid *re-requesting* a throttled host, not to
 * discard a body already in hand (see `arxiv.ts`).
 *
 * Note this deliberately does *not* rethrow a plain block (403, or LinkedIn's
 * nonstandard 999 for datacenter IPs): those aren't retry-after-a-while
 * signals, and falling back to the generic fetch is a better outcome than
 * failing the save.
 */
export async function fetchPluginPage(
  url: URL,
  pluginName: string,
  options?: FetchPluginPageOptions
): Promise<PluginPage | null> {
  try {
    const result = await fetchHtmlPage(url.href);
    if (result.isMarkdown) {
      return null;
    }
    return { html: result.content, finalUrl: result.finalUrl };
  } catch (error) {
    if (error instanceof HttpFetchError) {
      if (error.isRateLimited()) {
        throw error;
      }
      if (error.status === 404 && options?.notFoundIsExpected) {
        logger.debug("Plugin page not available", { plugin: pluginName, url: url.href });
        return null;
      }
    }
    logger.warn("Plugin page fetch failed, falling back to normal handling", {
      plugin: pluginName,
      url: url.href,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
