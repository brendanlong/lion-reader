import { fetchHtmlPage, HttpFetchError } from "@/server/http/fetch";
import { logger } from "@/lib/logger";

/** A fetched page, plus the URL it ended up at after redirects. */
export interface PluginPage {
  html: string;
  finalUrl: string;
}

/**
 * Fetch a page on behalf of a plugin whose only source is the public HTML
 * (LinkedIn, Threads).
 *
 * Returns null when the page couldn't be fetched or wasn't HTML, so the plugin
 * returns null in turn and the save falls back to normal handling. That is the
 * right default here: these sources block, auth-wall, and change markup
 * routinely, and none of it should fail the save.
 *
 * **Rate limiting is the exception and is rethrown.** Falling back would
 * immediately re-request the very host that just throttled us; `saveArticle`'s
 * `acquireArticleContent` catches it and surfaces `upstreamRateLimited`
 * instead. `lesswrong.ts` rethrows for the same reason.
 *
 * Note this deliberately does *not* rethrow a plain block (403, or LinkedIn's
 * nonstandard 999 for datacenter IPs): those aren't retry-after-a-while
 * signals, and falling back to the generic fetch is a better outcome than
 * failing the save.
 */
export async function fetchPluginPage(url: URL, pluginName: string): Promise<PluginPage | null> {
  try {
    const result = await fetchHtmlPage(url.href);
    if (result.isMarkdown) {
      return null;
    }
    return { html: result.content, finalUrl: result.finalUrl };
  } catch (error) {
    if (error instanceof HttpFetchError && error.isRateLimited()) {
      throw error;
    }
    logger.warn("Plugin page fetch failed, falling back to normal handling", {
      plugin: pluginName,
      url: url.href,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
