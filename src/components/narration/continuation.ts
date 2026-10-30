/**
 * Hands narration from an article that finished to the next one, across the
 * entry view remounting for it: the finished article's narration notes it
 * here, then the next article's takes it as it mounts and plays.
 */

let finishedArticleId: string | null = null;

export function continueNarrationFrom(articleId: string): void {
  finishedArticleId = articleId;
}

/** Whether narration went on to `articleId`, from another article; asking clears it. */
export function takeNarrationContinuation(articleId: string): boolean {
  const from = finishedArticleId;
  finishedArticleId = null;
  return from !== null && from !== articleId;
}
