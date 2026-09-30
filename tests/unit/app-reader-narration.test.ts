// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { htmlToClientNarration } from "@/lib/narration/client-paragraph-ids";
import {
  narrationParagraphForElement,
  splitNarrationParagraphs,
} from "@/lib/narration/paragraph-map";

const ARTICLE =
  "<p>First paragraph.</p><h2>A heading</h2><ul><li>One</li><li>Two</li></ul>" +
  '<figure><img src="x.png" alt="A chart"><figcaption>Caption</figcaption></figure>' +
  "<p>Last <b>paragraph</b>.</p>";

const messages: { type: string; paragraphs?: string[]; paragraph?: number }[] = [];

beforeAll(async () => {
  // The app's reader document: its header and summary ahead of the article.
  document.body.innerHTML =
    '<header class="lr-header"><h1>Title</h1><p class="lr-byline">Feed</p></header>' +
    '<aside class="lr-summary"><p>Summary</p></aside>' +
    ARTICLE;
  window.lionReader = { postMessage: (message) => messages.push(JSON.parse(message)) };
  await import("@/lib/narration/app-reader");
});

describe("the app reader's narration", () => {
  const web = htmlToClientNarration(ARTICLE);

  it("narrates the article as the web does, without the header or summary", () => {
    expect(messages[0]).toEqual({
      type: "narration",
      paragraphs: splitNarrationParagraphs(web.narrationText),
    });
  });

  it("numbers the article's elements as the web does, and leaves the rest alone", () => {
    const article = document.body.cloneNode(true) as HTMLElement;
    article.querySelectorAll(".lr-header, .lr-summary").forEach((el) => el.remove());
    expect(article.innerHTML).toBe(web.processedHtml);
    expect(document.querySelector(".lr-header [data-para-id]")).toBeNull();
    expect(document.body.firstElementChild?.className).toBe("lr-header");
  });

  it("highlights a paragraph's element", () => {
    window.lionNarration?.highlight(1, false);
    const element = web.paragraphMap[1].o;
    const highlighted = document.querySelectorAll(".lr-narrating");
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0].getAttribute("data-para-id")).toBe(`para-${element}`);

    window.lionNarration?.highlight(null, false);
    expect(document.querySelectorAll(".lr-narrating")).toHaveLength(0);
  });

  it("reports the paragraph a tap lands on", () => {
    const item = document.querySelectorAll("li")[1];
    item.click();
    const element = Number(item.getAttribute("data-para-id")?.slice("para-".length));
    expect(messages.at(-1)).toEqual({
      type: "seek",
      paragraph: narrationParagraphForElement(web.paragraphMap, element),
    });
  });
});
