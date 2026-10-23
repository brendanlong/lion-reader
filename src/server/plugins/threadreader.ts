import type { UrlPlugin, SavedArticleContent } from "./types";
import { socialPostTitle } from "./social-post";
import { fetchPluginPage } from "./fetch-page";
import { createSaxParser } from "@/server/html/sax";
import { stripHtml } from "@/server/html/strip-html";
import { logger } from "@/lib/logger";

/**
 * Thread Reader App plugin (saved articles only).
 *
 * A thread page shows the unrolled thread and, below it, a "More from @author"
 * list previewing the author's other threads. Readability scores whichever
 * block has more text, so a thread shorter than those previews is saved as one
 * of them: a one-tweet thread came out as a 9-tweet preview of an unrelated
 * thread. The thread's own tweets are the `div.content-tweet`s with ids
 * `tweet_1`, `tweet_2`, …; the previews' tweets have neither the id nor
 * `data-tweet`. This plugin hands Readability only the thread's tweets, which
 * it still cleans up (the tweets separate paragraphs with `<br>` runs).
 *
 * `threadreaderapp.com/robots.txt` allows `/thread/{id}.html`; it disallows
 * only the `/thread/{id}/fetch` and `/refresh` actions, which this never
 * requests.
 */

const THREADREADER_HOSTS = ["threadreaderapp.com", "www.threadreaderapp.com"];

/** The tweet id a thread URL (`/thread/{id}` or `/thread/{id}.html`) unrolls. */
export function parseThreadReaderId(url: URL): string | null {
  return /^\/thread\/(\d+)(?:\.html)?$/.exec(url.pathname)?.[1] ?? null;
}

const TWEET_ID_PATTERN = /^tweet_\d+$/;

interface ThreadTweet {
  html: string;
  /** `data-tweet`: the tweet's own id. */
  tweetId: string | undefined;
  screenName: string | undefined;
}

function hasClass(attribs: Record<string, string>, name: string): boolean {
  return attribs.class?.split(/\s+/).includes(name) ?? false;
}

/**
 * The thread's tweets as their inner HTML, minus the permalink icon each one
 * ends with, plus the thread's date (the first `data-time`, which the header
 * carries before the first tweet).
 */
function extractThreadTweets(html: string): { tweets: ThreadTweet[]; publishedAt: Date | null } {
  const tweets: ThreadTweet[] = [];
  let publishedAt: Date | null = null;
  let depth = 0;
  let current: (ThreadTweet & { depth: number; start: number }) | null = null;
  let permalink: { depth: number; start: number } | null = null;

  const parser = createSaxParser({
    onopentag(name, attribs) {
      depth++;
      if (current) {
        if (!permalink && name === "sup" && hasClass(attribs, "tw-permalink")) {
          permalink = { depth, start: parser.startIndex };
        }
        return;
      }
      if (!publishedAt && tweets.length === 0 && attribs["data-time"]) {
        const seconds = Number(attribs["data-time"]);
        if (Number.isFinite(seconds) && seconds > 0) publishedAt = new Date(seconds * 1000);
      }
      if (
        name === "div" &&
        TWEET_ID_PATTERN.test(attribs.id ?? "") &&
        hasClass(attribs, "content-tweet")
      ) {
        current = {
          html: "",
          tweetId: attribs["data-tweet"],
          screenName: attribs["data-screenname"],
          depth,
          start: parser.endIndex + 1,
        };
      }
    },
    onclosetag() {
      if (current && permalink?.depth === depth) {
        current.html += html.slice(current.start, permalink.start);
        current.start = parser.endIndex + 1;
        permalink = null;
      } else if (current?.depth === depth) {
        current.html += html.slice(current.start, parser.startIndex);
        tweets.push({
          html: current.html.trim(),
          tweetId: current.tweetId,
          screenName: current.screenName,
        });
        current = null;
      }
      depth--;
    },
  });
  parser.write(html);
  parser.end();

  return { tweets, publishedAt };
}

/**
 * The thread on a fetched Thread Reader page, or null unless the page's first
 * tweet is the one the URL unrolls: anything else (a "thread not found" page,
 * changed markup) falls back to normal fetching.
 */
export function renderThreadReaderPage(
  html: string,
  threadId: string,
  canonicalUrl: string
): SavedArticleContent | null {
  const { tweets, publishedAt } = extractThreadTweets(html);
  const first = tweets[0];
  if (!first || first.tweetId !== threadId) return null;

  const author = first.screenName ? `@${first.screenName}` : null;
  return {
    html: tweets.map((tweet) => `<div>${tweet.html}</div>`).join("\n"),
    title: socialPostTitle(stripHtml(first.html.split(/<br\b/i)[0]), author),
    author,
    publishedAt,
    canonicalUrl,
  };
}

export const threadReaderPlugin: UrlPlugin = {
  name: "threadreader",
  hosts: THREADREADER_HOSTS,

  matchUrl(url: URL): boolean {
    return parseThreadReaderId(url) !== null;
  },

  capabilities: {
    savedArticle: {
      siteName: "Thread Reader",

      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        const threadId = parseThreadReaderId(url);
        if (!threadId) return null;
        const page = await fetchPluginPage(url, "threadreader");
        if (!page) return null;

        const content = renderThreadReaderPage(page.html, threadId, page.finalUrl);
        if (!content) {
          logger.info("Thread Reader page carried no thread", { url: url.href });
        }
        return content;
      },
    },
  },
};
