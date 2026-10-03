/**
 * Records the demo's narration (`src/app/(public)/demo/narration.ts`): every
 * chunk the demo's player will ask for, spoken by the cloud voice and stored
 * in the public bucket under its key (`@/lib/narration/prerecorded-speech`).
 * Only keys not already stored are synthesized, so after editing an article
 * this records just the chunks whose text changed. It then writes the list of
 * keys each article needs, which a unit test checks against the articles, so
 * an article can't change without being recorded again.
 *
 * Needs the speech provider's API key (e.g. `DEEPINFRA_API_KEY`) and the
 * bucket's `STORAGE_*` credentials in the environment.
 *
 * Usage: pnpm demo:narration
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEMO_ENTRIES } from "@/app/(public)/demo/data";
import { DEMO_NARRATION_VOICE } from "@/app/(public)/demo/narration";
import { parseModelRef } from "@/lib/ai/model-ref";
import { cloudSpeechTexts } from "@/lib/narration/cloud-speech";
import { buildAlignedNarration } from "@/lib/narration/paragraph-map";
import { parseBodyAsBrowser } from "@/lib/narration/parse-html";
import { DIRECT_TTS_VOICE, narrationRuns } from "@/lib/narration/runs";
import {
  prerecordedSpeechKey,
  prerecordedSpeechObjectKey,
} from "@/lib/narration/prerecorded-speech";

export const DEMO_NARRATION_MANIFEST_PATH = "src/app/(public)/demo/narration-recordings.json";

/** Article id → the keys of its chunks, in the order they're played. */
export type DemoNarrationManifest = Record<string, string[]>;

/** One chunk of an article's narration, as the demo's player asks for it. */
interface Recording {
  key: string;
  text: string;
}

/**
 * What the browser narrates for `html` without an LLM (`htmlToClientNarration`),
 * from the browser's tree as the server builds it.
 */
export function demoNarrationText(html: string): string {
  return buildAlignedNarration(narrationRuns(parseBodyAsBrowser(html), DIRECT_TTS_VOICE))
    .narrationText;
}

/** Each article's chunks, as the demo's player asks for them. */
export async function demoNarrationRecordings(): Promise<Map<string, Recording[]>> {
  const recordings = new Map<string, Recording[]>();
  for (const entry of DEMO_ENTRIES) {
    recordings.set(
      entry.id,
      await Promise.all(
        cloudSpeechTexts(demoNarrationText(entry.contentHtml)).map(async (text) => ({
          key: await prerecordedSpeechKey(DEMO_NARRATION_VOICE, text),
          text,
        }))
      )
    );
  }
  return recordings;
}

export function toManifest(recordings: Map<string, Recording[]>): DemoNarrationManifest {
  return Object.fromEntries(
    [...recordings].map(([id, chunks]) => [id, chunks.map((chunk) => chunk.key)])
  );
}

async function main(): Promise<void> {
  // Loaded here, not at the top, so the unit test of the manifest doesn't
  // load the server.
  const { SPEECH_PROVIDERS } = await import("@/lib/ai/providers");
  const { AI_PROVIDER_ENV_KEYS } = await import("@/server/services/ai-providers");
  const { listSpeechModels, streamSpeech } = await import("@/server/services/speech");
  const { objectExists, uploadObject } = await import("@/server/storage/s3");

  // As the operator's own keys, so the allowlist for keys the server lends
  // users doesn't apply.
  const keys = Object.fromEntries(
    SPEECH_PROVIDERS.map((provider) => [provider, process.env[AI_PROVIDER_ENV_KEYS[provider]]])
  );
  const voice = DEMO_NARRATION_VOICE;
  const provider = parseModelRef(voice.model).provider;
  if (!keys[provider]) {
    throw new Error(`Set ${AI_PROVIDER_ENV_KEYS[provider]} to record with ${voice.model}`);
  }
  // Speech falls back to a model's default voice when it has no such one,
  // which would be stored as this one.
  const { models } = await listSpeechModels(keys);
  const model = models.find((candidate) => candidate.id === voice.model);
  if (!model?.voices.some((candidate) => candidate.id === voice.voice)) {
    throw new Error(`${voice.model} has no voice ${voice.voice}`);
  }

  const recordings = await demoNarrationRecordings();
  const unique = new Map<string, string>();
  for (const chunks of recordings.values()) {
    for (const { key, text } of chunks) unique.set(key, text);
  }

  let recorded = 0;
  let characters = 0;
  for (const [key, text] of unique) {
    const objectKey = prerecordedSpeechObjectKey(key);
    if (await objectExists(objectKey)) continue;
    const audio = await new Response(
      await streamSpeech(keys, {
        model: voice.model,
        voice: voice.voice,
        text,
        pauseSeconds: voice.pauseSeconds,
        userId: "demo-narration",
      })
    ).bytes();
    await uploadObject(objectKey, audio, "audio/mp4");
    recorded++;
    characters += text.length;
    console.log(`Recorded ${key} (${text.length} characters)`);
  }

  writeFileSync(
    DEMO_NARRATION_MANIFEST_PATH,
    `${JSON.stringify(toManifest(recordings), null, 2)}\n`
  );
  console.log(
    `${unique.size} chunks: recorded ${recorded} (${characters} characters), ` +
      `${unique.size - recorded} already stored. Wrote ${DEMO_NARRATION_MANIFEST_PATH}`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
