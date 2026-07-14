/**
 * Narration paragraph mapping.
 *
 * The narration player splits the narration text into paragraphs on blank lines
 * (`\n\n`) and reports the index of the paragraph it is currently speaking. The
 * highlighter turns that index into a DOM element via the `paragraphMap`, which
 * maps each narration paragraph index (`n`) to the `data-para-id` of the block
 * element it came from (`o`).
 *
 * For highlighting to stay in sync, the map MUST have exactly one entry per
 * paragraph the player sees — i.e. per `\n\n`-delimited segment of the narration
 * text, in order. A block element's narration text can itself contain blank-line
 * breaks (source newlines around `<br><br>`, or an LLM that reflows a run-on
 * block into multiple paragraphs), so "one map entry per block element" is NOT
 * the same as "one map entry per player paragraph". When they diverge, every
 * highlight after the first multi-paragraph block lands on the wrong element
 * (issue: highlighting desynced on `<br><br>`-formatted articles while clean
 * per-`<p>` articles worked).
 *
 * `buildAlignedNarration` is the single place that derives the narration text and
 * its map together so the invariant `splitNarrationParagraphs(narrationText)[i]`
 * ↔ `paragraphMap[i]` holds by construction, regardless of how the source text
 * is chunked. Every generation path (client-side, server LLM, server fallback)
 * goes through it.
 *
 * @module narration/paragraph-map
 */

/**
 * Paragraph mapping entry for highlighting support.
 * Maps a narration paragraph index to the original HTML element index.
 */
export interface ParagraphMapEntry {
  /** Narration paragraph index (0-based, matches the player's paragraph index) */
  n: number;
  /** Original HTML element index (corresponds to `data-para-id="para-{o}"`) */
  o: number;
}

/**
 * Splits narration text into paragraphs exactly as the playback engines do.
 *
 * This MUST stay identical to the splitting in `ArticleNarrator.loadArticle`,
 * `StreamingAudioPlayer` (fed via `splitIntoParagraphs`), and
 * `useNarrationTypes.splitIntoParagraphs` — they all consume the output of this
 * module's `buildAlignedNarration`, so a divergent split would break the
 * paragraph-index ↔ map alignment.
 */
export function splitNarrationParagraphs(text: string): string[] {
  return text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * A block element's contribution to the narration: its narration text and the
 * original element index (`data-para-id`) it should highlight.
 */
export interface NarrationElement {
  /** Original HTML element index (corresponds to `data-para-id="para-{o}"`) */
  o: number;
  /** The element's narration text (may be empty, may contain blank-line breaks) */
  text: string;
}

/**
 * Builds the narration text and a paragraph map that are guaranteed to stay
 * aligned with `splitNarrationParagraphs(narrationText)`.
 *
 * Each element may expand into zero, one, or many narration paragraphs:
 * - empty (or whitespace-only) text contributes nothing (and no map entry);
 * - text with blank-line breaks contributes one paragraph per segment, all
 *   mapping back to the same original element index `o`.
 *
 * The returned `narrationText` is the segments joined by `\n\n`, so
 * `splitNarrationParagraphs(narrationText)[i]` corresponds to `paragraphMap[i]`
 * for every `i`.
 */
export function buildAlignedNarration(elements: NarrationElement[]): {
  narrationText: string;
  paragraphMap: ParagraphMapEntry[];
} {
  const paragraphs: string[] = [];
  const paragraphMap: ParagraphMapEntry[] = [];

  for (const el of elements) {
    for (const segment of splitNarrationParagraphs(el.text)) {
      paragraphMap.push({ n: paragraphs.length, o: el.o });
      paragraphs.push(segment);
    }
  }

  return {
    narrationText: paragraphs.join("\n\n"),
    paragraphMap,
  };
}
