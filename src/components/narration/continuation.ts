/**
 * Hands narration from an article that finished to the next one, across the
 * entry view remounting for it: the finished article's narration notes where
 * it went on to, and the next entry view to open reads it and clears it.
 */

let nextArticleId: string | null = null;

export function continueNarrationTo(articleId: string): void {
  nextArticleId = articleId;
}

export function narrationContinuesTo(articleId: string): boolean {
  return nextArticleId === articleId;
}

export function clearNarrationContinuation(): void {
  nextArticleId = null;
}
