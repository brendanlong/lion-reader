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
 * Splits a paragraph into individual sentences.
 *
 * @param text - The paragraph text to split
 * @returns Array of sentence strings, preserving original text
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

  // If no sentences were detected, return the original text as a single sentence
  // This handles edge cases where the text has no sentence-ending punctuation
  if (sentences.length === 0 && text.trim().length > 0) {
    return [text.trim()];
  }

  return sentences;
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
