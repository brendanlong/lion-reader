/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { DEMO_ENTRIES } from "@/lib/demo/data";
import { cloudSpeechTexts } from "@/lib/narration/cloud-speech";
import { htmlToClientNarration } from "@/lib/narration/client-paragraph-ids";
import { NEXT_ARTICLE, NO_MORE_ARTICLES, withEndOfArticle } from "@/lib/narration/paragraph-map";
import {
  demoNarrationCatalog,
  demoNarrationText,
  getDemoNarrationVoice,
} from "@/server/services/demo-narration";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Every version of an article the reader can show: the feed's, and any fuller one. */
const DEMO_HTML = DEMO_ENTRIES.flatMap((entry) => [
  [entry.id, entry.contentHtml],
  ...(entry.fullContentHtml ? [[`${entry.id} (full)`, entry.fullContentHtml]] : []),
]);

describe("demo narration catalog", () => {
  it.each(DEMO_HTML)("has the text the browser narrates: %s", (_id, html) => {
    expect(demoNarrationText(html)).toBe(
      withEndOfArticle(htmlToClientNarration(html)).narrationText
    );
  });

  it("has every chunk the player asks for, however narration ends", async () => {
    vi.stubEnv("DEMO_NARRATION_MODEL", "selfhosted:kokoro");
    vi.stubEnv("DEMO_NARRATION_VOICE", "af_heart");
    const texts = new Set([...(await demoNarrationCatalog()).values()].map((chunk) => chunk.text));
    for (const [, html] of DEMO_HTML) {
      for (const following of [undefined, NEXT_ARTICLE, NO_MORE_ARTICLES]) {
        for (const text of cloudSpeechTexts(
          withEndOfArticle(htmlToClientNarration(html), following).narrationText
        )) {
          expect(texts).toContain(text);
        }
      }
    }
  });
});

describe("the demo's narration voice", () => {
  it("is set by both env vars, or neither, never one", () => {
    vi.stubEnv("DEMO_NARRATION_MODEL", "selfhosted:kokoro");
    vi.stubEnv("DEMO_NARRATION_VOICE", "af_heart");
    expect(getDemoNarrationVoice()).toMatchObject({
      model: "selfhosted:kokoro",
      voice: "af_heart",
    });
    vi.stubEnv("DEMO_NARRATION_VOICE", "");
    expect(() => getDemoNarrationVoice()).toThrow();
    vi.stubEnv("DEMO_NARRATION_MODEL", "");
    expect(getDemoNarrationVoice()).toBeNull();
  });

  it("records nothing when unset, so the recording route speaks nothing (SECURITY.md section 10)", async () => {
    vi.resetModules();
    const fresh = await import("@/server/services/demo-narration");
    expect((await fresh.demoNarrationCatalog()).size).toBe(0);
  });
});
