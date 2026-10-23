/**
 * Unit tests for the Thread Reader App plugin, against page shapes captured
 * from threadreaderapp.com — no network.
 */

import { describe, it, expect } from "vitest";
import {
  threadReaderPlugin,
  parseThreadReaderId,
  renderThreadReaderPage,
} from "@/server/plugins/threadreader";

const THREAD_ID = "2113398193614655594";
const THREAD_URL = `https://threadreaderapp.com/thread/${THREAD_ID}.html`;

function tweet(n: number, id: string, body: string): string {
  return `<div id="tweet_${n}" class="content-tweet allow-preview" data-controller="thread" data-action="click->thread#showTweet" data-screenname="alexeheath" data-tweet="${id}" dir="auto">
        ${body}
        <sup class="tw-permalink"><i class="fas fa-link"></i></sup>
      </div>`;
}

/**
 * A thread page: header with the thread's date, the thread's tweets, then a
 * "More from" list whose previews carry far more text than a short thread.
 */
function page(tweets: string[]): string {
  const preview = Array.from(
    { length: 3 },
    (_, i) =>
      `<div class="content-tweet">Preview of another thread, tweet ${i}. ${"Unrelated words here. ".repeat(30)}</div>`
  ).join("");
  return `<html><head><title>Thread by @alexeheath on Thread Reader App</title></head><body>
    <div class="thread-info"><a href="https://twitter.com/alexeheath/status/${THREAD_ID}" class="time" data-time="1792708369">Oct 22</a></div>
    ${tweets.join("\n")}
    <h1 class="separator">More from @alexeheath</h1>
    <div data-controller="link"><span class="time" data-time="1783716735">Jul 10</span>
      <div class="card-tweets" dir="auto">${preview}</div><a>Read 9 tweets</a></div>
  </body></html>`;
}

describe("parseThreadReaderId", () => {
  it("parses thread URLs with and without .html", () => {
    expect(parseThreadReaderId(new URL(THREAD_URL))).toBe(THREAD_ID);
    expect(parseThreadReaderId(new URL(`https://threadreaderapp.com/thread/${THREAD_ID}`))).toBe(
      THREAD_ID
    );
  });

  it("rejects pages that aren't a thread", () => {
    expect(
      threadReaderPlugin.matchUrl(new URL("https://threadreaderapp.com/user/alexeheath"))
    ).toBe(false);
    expect(
      threadReaderPlugin.matchUrl(
        new URL(`https://threadreaderapp.com/thread/${THREAD_ID}/refresh`)
      )
    ).toBe(false);
  });
});

describe("renderThreadReaderPage", () => {
  it("saves a short thread rather than the longer previews below it", () => {
    const html = page([
      tweet(1, THREAD_ID, "I asked Google CEO Pichai what happened.<br />\n<br />\nHe said a lot."),
    ]);

    const content = renderThreadReaderPage(html, THREAD_ID, THREAD_URL);

    expect(content).toMatchObject({
      title: "I asked Google CEO Pichai what happened.",
      author: "@alexeheath",
      publishedAt: new Date(1792708369 * 1000),
      canonicalUrl: THREAD_URL,
    });
    expect(content?.html).toContain("He said a lot.");
    expect(content?.html).not.toContain("Preview of another thread");
    expect(content?.html).not.toContain("tw-permalink");
  });

  it("keeps every tweet of a longer thread, in order", () => {
    const html = page([
      tweet(1, THREAD_ID, "First tweet."),
      tweet(
        2,
        "2113398193614655600",
        'Second tweet with a <a href="https://example.com">link</a>.'
      ),
      tweet(3, "2113398193614655601", "Third tweet."),
    ]);

    const content = renderThreadReaderPage(html, THREAD_ID, THREAD_URL);

    expect(content?.html).toMatch(/First tweet\.[\s\S]*Second tweet[\s\S]*Third tweet\./);
    expect(content?.html).toContain('<a href="https://example.com">link</a>');
    expect(content?.html).not.toContain("Preview of another thread");
  });

  it("declines a page whose first tweet isn't the requested thread", () => {
    const html = page([tweet(1, "999", "Some other thread.")]);
    expect(renderThreadReaderPage(html, THREAD_ID, THREAD_URL)).toBeNull();
    expect(renderThreadReaderPage(page([]), THREAD_ID, THREAD_URL)).toBeNull();
  });
});
