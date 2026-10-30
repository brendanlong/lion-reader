/**
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { DEMO_ENTRIES } from "@/lib/demo/data";
import { cloudSpeechTexts } from "@/lib/narration/cloud-speech";
import { htmlToClientNarration } from "@/lib/narration/client-paragraph-ids";
import { NEXT_ARTICLE, NO_MORE_ARTICLES, withEndOfArticle } from "@/lib/narration/paragraph-map";
import { demoNarrationCatalog, demoNarrationText } from "@/server/services/demo-narration";

describe("demo narration catalog", () => {
  it.each(DEMO_ENTRIES.map((entry) => [entry.id, entry.contentHtml]))(
    "has the text the browser narrates: %s",
    (_id, html) => {
      expect(demoNarrationText(html)).toBe(
        withEndOfArticle(htmlToClientNarration(html)).narrationText
      );
    }
  );

  it("has every chunk the player asks for, however narration ends", async () => {
    const texts = new Set([...(await demoNarrationCatalog()).values()].map((chunk) => chunk.text));
    for (const entry of DEMO_ENTRIES) {
      for (const following of [undefined, NEXT_ARTICLE, NO_MORE_ARTICLES]) {
        for (const text of cloudSpeechTexts(
          withEndOfArticle(htmlToClientNarration(entry.contentHtml), following).narrationText
        )) {
          expect(texts).toContain(text);
        }
      }
    }
  });
});
