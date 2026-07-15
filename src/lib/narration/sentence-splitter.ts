/**
 * Sentence Splitter Utility
 *
 * Splits paragraph text into individual sentences for better TTS quality.
 * Uses the sentence-splitter library which handles edge cases like:
 * - Abbreviations (Dr., Mr., U.S.A.)
 * - Quoted text ("He said 'hello.'")
 * - Multiple punctuation marks
 *
 * @module narration/sentence-splitter
 */

import { split, SentenceSplitterSyntax } from "sentence-splitter";

/**
 * Maximum number of characters in a single TTS synthesis chunk.
 *
 * Neural TTS (Piper) synthesizes one chunk in a single pass, and very long
 * chunks get rushed and muddled (the model compresses too much speech into one
 * breath). We therefore split sentences longer than this at clause boundaries
 * so each chunk stays a comfortable, natural length. Chosen so ordinary
 * sentences stay whole while run-on sentences (e.g. a 400-char sentence full of
 * comma-separated clauses) break into clause-sized pieces.
 */
export const MAX_CHUNK_CHARS = 180;

/**
 * Split text at clause-level punctuation (commas, semicolons, colons, dashes)
 * followed by whitespace. The punctuation stays with the preceding clause; the
 * whitespace is dropped. Empty pieces are filtered out.
 */
function splitAtClauseBoundaries(text: string): string[] {
  const parts: string[] = [];
  // Each of these separators is a single UTF-16 code unit, so `index + 1`
  // reliably keeps the punctuation attached to the clause before it.
  const separator = /[,;:—–]\s+/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(text)) !== null) {
    const end = match.index + 1;
    const clause = text.slice(lastIndex, end).trim();
    if (clause.length > 0) {
      parts.push(clause);
    }
    lastIndex = match.index + match[0].length;
  }
  const tail = text.slice(lastIndex).trim();
  if (tail.length > 0) {
    parts.push(tail);
  }
  return parts;
}

/**
 * Split text at word boundaries, greedily packing words up to `maxChars`.
 * Used as a last resort for a single clause that still exceeds the limit.
 */
function splitAtWords(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (word.length === 0) continue;
    if (current && current.length + 1 + word.length > maxChars) {
      chunks.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Break a single sentence into chunks no longer than `maxChars`, preferring
 * clause boundaries and falling back to word boundaries only when a lone clause
 * is still too long. Sentences within the limit are returned unchanged.
 */
export function splitLongSentence(text: string, maxChars: number = MAX_CHUNK_CHARS): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  // Break into clauses, then further break any clause that is still too long.
  const pieces: string[] = [];
  for (const clause of splitAtClauseBoundaries(text)) {
    if (clause.length > maxChars) {
      pieces.push(...splitAtWords(clause, maxChars));
    } else {
      pieces.push(clause);
    }
  }

  // Greedily recombine adjacent pieces so we don't over-split (e.g. two short
  // clauses that comfortably fit together stay together).
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + 1 + piece.length > maxChars) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }

  // Defensive fallback: if we somehow produced nothing, keep the original text.
  return chunks.length > 0 ? chunks : [text];
}

/**
 * Splits a paragraph into individual sentences.
 *
 * Sentences longer than {@link MAX_CHUNK_CHARS} are further split at clause
 * boundaries so neural TTS doesn't rush through them (see {@link splitLongSentence}).
 *
 * @param text - The paragraph text to split
 * @returns Array of sentence/chunk strings, preserving original text
 */
export function splitIntoSentences(text: string): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const nodes = split(text);
  const sentences: string[] = [];

  for (const node of nodes) {
    if (node.type === SentenceSplitterSyntax.Sentence) {
      // Extract the raw text from the sentence node
      const sentenceText = text.slice(node.range[0], node.range[1]).trim();
      if (sentenceText.length > 0) {
        sentences.push(sentenceText);
      }
    }
  }

  // If no sentences were detected, treat the original text as a single sentence.
  // This handles edge cases where the text has no sentence-ending punctuation.
  if (sentences.length === 0 && text.trim().length > 0) {
    sentences.push(text.trim());
  }

  // Split any over-long sentences so each synthesis chunk stays a natural length.
  return sentences.flatMap((sentence) => splitLongSentence(sentence));
}

/**
 * Splits a paragraph into sentences, returning both the sentences
 * and metadata about each one.
 *
 * @param text - The paragraph text to split
 * @returns Array of sentence info objects
 */
export interface SentenceInfo {
  /** The sentence text */
  text: string;
  /** Start offset in original text */
  start: number;
  /** End offset in original text */
  end: number;
}

export function splitIntoSentencesWithInfo(text: string): SentenceInfo[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const nodes = split(text);
  const sentences: SentenceInfo[] = [];

  for (const node of nodes) {
    if (node.type === SentenceSplitterSyntax.Sentence) {
      const sentenceText = text.slice(node.range[0], node.range[1]).trim();
      if (sentenceText.length > 0) {
        sentences.push({
          text: sentenceText,
          start: node.range[0],
          end: node.range[1],
        });
      }
    }
  }

  // If no sentences were detected, return the original text as a single sentence
  if (sentences.length === 0 && text.trim().length > 0) {
    return [
      {
        text: text.trim(),
        start: 0,
        end: text.length,
      },
    ];
  }

  return sentences;
}
