/**
 * The demo's narration as recordings (`@/lib/narration/prerecorded-speech`):
 * every chunk its player can ask for, by key. These are the only texts
 * `/api/prerecorded-speech` will synthesize, which is what keeps an
 * unauthenticated route from speaking arbitrary text on the server's key.
 */

import { DEMO_ENTRIES } from "@/lib/demo/data";
import { DEMO_NARRATION_VOICE } from "@/lib/demo/narration";
import { cloudSpeechTexts } from "@/lib/narration/cloud-speech";
import {
  buildAlignedNarration,
  NEXT_ARTICLE,
  NO_MORE_ARTICLES,
  withEndOfArticle,
} from "@/lib/narration/paragraph-map";
import { parseBodyAsBrowser } from "@/lib/narration/parse-html";
import { prerecordedSpeechKey, type PrerecordedVoice } from "@/lib/narration/prerecorded-speech";
import { DIRECT_TTS_VOICE, narrationRuns } from "@/lib/narration/runs";

export interface PrerecordedChunk {
  voice: PrerecordedVoice;
  text: string;
}

/**
 * What the browser narrates for `html` without an LLM (`htmlToClientNarration`),
 * from the browser's tree as the server builds it, ending as `useEntryNarration`
 * has it end.
 */
export function demoNarrationText(html: string, following?: string): string {
  return withEndOfArticle(
    buildAlignedNarration(narrationRuns(parseBodyAsBrowser(html), DIRECT_TTS_VOICE)),
    following
  ).narrationText;
}

async function buildCatalog(): Promise<Map<string, PrerecordedChunk>> {
  const catalog = new Map<string, PrerecordedChunk>();
  for (const entry of DEMO_ENTRIES) {
    for (const following of [undefined, NEXT_ARTICLE, NO_MORE_ARTICLES]) {
      for (const text of cloudSpeechTexts(demoNarrationText(entry.contentHtml, following))) {
        const key = await prerecordedSpeechKey(DEMO_NARRATION_VOICE, text);
        catalog.set(key, { voice: DEMO_NARRATION_VOICE, text });
      }
    }
  }
  return catalog;
}

let catalog: Promise<Map<string, PrerecordedChunk>> | null = null;

/** Every chunk of the demo's narration, by key; built once. */
export function demoNarrationCatalog(): Promise<Map<string, PrerecordedChunk>> {
  catalog ??= buildCatalog();
  return catalog;
}
