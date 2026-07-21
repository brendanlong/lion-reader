import { generateSummary, summarizeCleanedContent, truncateText } from "@/server/html/strip-html";

/** Max length of a saved-article excerpt, matching {@link generateSummary}. */
const MAX_EXCERPT_LENGTH = 300;

/**
 * Choose the plain-text excerpt for a saved article.
 *
 * Precedence: explicit plugin excerpt → pre-cleaned source summary (Markdown
 * frontmatter / docx `dc:description`) → Readability's cleaned extraction → raw
 * plugin HTML → raw pre-cleaned HTML.
 *
 * A plugin-supplied `excerpt` (e.g. the arXiv API abstract) is authoritative and
 * outranks everything, including Readability — the whole point of fetching it is
 * that it beats any scrape of the HTML render. It's plain text, so it's just
 * clipped to the summary length (arXiv abstracts run long — see #1399).
 *
 * Otherwise the `cleaned` (Readability) branch must be checked **before** the
 * plugin-HTML branch. When Readability ran, its output is what we store and
 * display, so the excerpt has to come from it too. Readability only runs
 * (leaving `cleaned` non-null) when it wasn't skipped, and a plugin can keep it
 * (`skipReadability: false`, e.g. arXiv). The raw arXiv HTML body opens with a
 * table-of-contents `<nav>`, so summarizing the raw plugin HTML yielded the ToC
 * instead of the article text (#1398). Plugins that skip Readability (Google
 * Docs) leave `cleaned` null and correctly fall through to their own HTML.
 *
 * The cleaned branch defers to the shared `summarizeCleanedContent`, so saved
 * articles and uploaded files derive excerpts identically (description-preferred).
 *
 * Pure (no DB/network) so it can be unit-tested directly.
 */
export function computeSavedArticleExcerpt(params: {
  preCleanedContent: { summary: string | null } | null;
  cleaned: { excerpt: string; textContent: string } | null;
  pluginContent: { html: string; excerpt?: string | null } | null;
  html: string;
}): string | null {
  const { preCleanedContent, cleaned, pluginContent, html } = params;

  if (pluginContent?.excerpt) {
    // Explicit plugin excerpt (arXiv abstract): authoritative, just clip it.
    return truncateText(pluginContent.excerpt, MAX_EXCERPT_LENGTH) || null;
  }
  if (preCleanedContent?.summary) {
    // Use the summary from the source metadata (frontmatter / docx description).
    return preCleanedContent.summary;
  }
  if (cleaned) {
    return summarizeCleanedContent(cleaned) || null;
  }
  if (pluginContent) {
    return generateSummary(pluginContent.html) || null;
  }
  if (preCleanedContent) {
    return generateSummary(html) || null;
  }
  return null;
}
