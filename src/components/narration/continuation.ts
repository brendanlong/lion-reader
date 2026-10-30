/**
 * Hands narration from an article that finished to the next one, across the
 * entry view remounting for it: the finished article's narration notes where
 * it went on to, and the next article's narration to mount takes it, playing
 * if it is that article.
 */

let nextArticleId: string | null = null;

export function continueNarrationTo(articleId: string): void {
  nextArticleId = articleId;
}

/** Whether narration went on to `articleId`; asking clears it. */
export function takeNarrationContinuation(articleId: string): boolean {
  const next = nextArticleId;
  nextArticleId = null;
  return next === articleId;
}
