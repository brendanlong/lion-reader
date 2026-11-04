/**
 * The demo's narration as recordings (`@/lib/narration/prerecorded-speech`):
 * every chunk its player can ask for, by key. These are the only texts
 * `/api/prerecorded-speech` will synthesize, which is what keeps an
 * unauthenticated route from speaking arbitrary text on the server's key.
 */

import { DEMO_ENTRIES } from "@/lib/demo/data";
import { cloudSpeechTexts } from "@/lib/narration/cloud-speech";
import { DEFAULT_CLOUD_SPEECH_PAUSE_SECONDS } from "@/lib/narration/constants";
import { normalizeModelRef } from "@/lib/ai/model-ref";
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

/**
 * The voice the demo narrates in, run on the server's keys with no plan:
 * `DEMO_NARRATION_MODEL` (a `provider:model` ref) and `DEMO_NARRATION_VOICE`.
 * Pick one that costs nothing per character, like the operator's own speech
 * server. Changing it records the demo again. Unset, the demo narrates with
 * the browser's voices. Startup calls it, so setting only one fails there.
 */
export function getDemoNarrationVoice(): PrerecordedVoice | null {
  const model = process.env.DEMO_NARRATION_MODEL?.trim();
  const voice = process.env.DEMO_NARRATION_VOICE?.trim();
  if (!model !== !voice) {
    throw new Error("Set both DEMO_NARRATION_MODEL and DEMO_NARRATION_VOICE, or neither");
  }
  return model && voice
    ? { model: normalizeModelRef(model), voice, pauseSeconds: DEFAULT_CLOUD_SPEECH_PAUSE_SECONDS }
    : null;
}

async function buildCatalog(): Promise<Map<string, PrerecordedChunk>> {
  const catalog = new Map<string, PrerecordedChunk>();
  const voice = getDemoNarrationVoice();
  if (!voice) return catalog;
  for (const entry of DEMO_ENTRIES) {
    for (const following of [undefined, NEXT_ARTICLE, NO_MORE_ARTICLES]) {
      for (const text of cloudSpeechTexts(demoNarrationText(entry.contentHtml, following))) {
        const key = await prerecordedSpeechKey(voice, text);
        catalog.set(key, { voice, text });
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
