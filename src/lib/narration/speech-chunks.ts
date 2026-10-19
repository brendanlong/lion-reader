/**
 * How narration text is cut into synthesis chunks, and how skips move between
 * the chunks of paragraphs.
 */

import { isSpeakable } from "./paragraph-map";
import { splitIntoSentences } from "./sentence-splitter";

export interface SpeechChunk {
  paragraph: number;
  text: string;
}

/** One chunk per sentence, for synthesis that's slow enough to want the first audio fast. */
export function splitIntoSentenceChunks(paragraphs: string[]): SpeechChunk[] {
  return paragraphs.flatMap((paragraph, index) =>
    splitIntoSentences(paragraph.trim())
      .filter(isSpeakable)
      .map((text) => ({ paragraph: index, text }))
  );
}

/**
 * Splits paragraphs into synthesis chunks of at most `maxChars`, breaking long
 * paragraphs at sentence boundaries so playback can start (and skip) without
 * waiting for a whole long paragraph.
 */
export function splitIntoSpeechChunks(paragraphs: string[], maxChars: number): SpeechChunk[] {
  return paragraphs
    .flatMap((paragraph, index) => splitParagraph(paragraph, index, maxChars))
    .filter((chunk) => isSpeakable(chunk.text));
}

function splitParagraph(paragraph: string, index: number, maxChars: number): SpeechChunk[] {
  const text = paragraph.trim();
  if (text.length <= maxChars) return [{ paragraph: index, text }];

  const chunks: SpeechChunk[] = [];
  let current = "";
  // Sentences are word-split at a much smaller size, but a run without
  // whitespace (a long URL, unspaced CJK text) can still exceed the limit.
  const pieces = splitIntoSentences(text).flatMap((sentence) => {
    const slices: string[] = [];
    for (let start = 0; start < sentence.length; start += maxChars) {
      slices.push(sentence.slice(start, start + maxChars));
    }
    return slices;
  });
  for (const sentence of pieces) {
    if (current && current.length + 1 + sentence.length > maxChars) {
      chunks.push({ paragraph: index, text: current });
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push({ paragraph: index, text: current });
  return chunks;
}

/** The first chunk of the paragraph after `index`'s; null on the last. */
export function nextParagraphChunk(chunks: readonly SpeechChunk[], index: number): number | null {
  const current = chunks[index]?.paragraph ?? 0;
  const next = chunks.findIndex((chunk) => chunk.paragraph > current);
  return next === -1 ? null : next;
}

/** The first chunk of the paragraph before `index`'s; null on the first. */
export function previousParagraphChunk(
  chunks: readonly SpeechChunk[],
  index: number
): number | null {
  const current = chunks[index]?.paragraph ?? 0;
  const previous = chunks.findLast((chunk) => chunk.paragraph < current)?.paragraph;
  if (previous === undefined) return null;
  return chunks.findIndex((chunk) => chunk.paragraph === previous);
}

/** The first chunk of `paragraph`, or of the next one with something to say; null past the end. */
export function paragraphChunk(chunks: readonly SpeechChunk[], paragraph: number): number | null {
  const index = chunks.findIndex((chunk) => chunk.paragraph >= paragraph);
  return index === -1 ? null : index;
}
