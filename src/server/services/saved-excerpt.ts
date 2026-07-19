import { generateSummary } from "@/server/html/strip-html";

/**
 * Choose the plain-text excerpt for a saved article.
 *
 * Precedence: Markdown frontmatter summary → Readability's cleaned extraction →
 * raw plugin HTML → raw Markdown HTML.
 *
 * The `cleaned` (Readability) branch must be checked **before** the plugin branch.
 * When Readability ran, its output is what we store and display, so the excerpt
 * has to come from it too. Readability only runs (leaving `cleaned` non-null) when
 * it wasn't skipped, and a plugin can keep it (`skipReadability: false`, e.g.
 * arXiv). The raw arXiv HTML body opens with a table-of-contents `<nav>`, so
 * summarizing the raw plugin HTML yielded the ToC instead of the article text
 * (#1398). Plugins that skip Readability (Google Docs) leave `cleaned` null and
 * correctly fall through to their own HTML.
 *
 * Pure (no DB/network) so it can be unit-tested directly.
 */
export function computeSavedArticleExcerpt(params: {
  markdownResult: { summary: string | null } | null;
  cleaned: { excerpt: string; textContent: string } | null;
  pluginContent: { html: string } | null;
  html: string;
}): string | null {
  const { markdownResult, cleaned, pluginContent, html } = params;

  if (markdownResult?.summary) {
    // Use summary from frontmatter
    return markdownResult.summary;
  }
  if (cleaned) {
    let excerpt = cleaned.excerpt || cleaned.textContent.slice(0, 300).trim() || null;
    if (excerpt && excerpt.length > 300) {
      excerpt = excerpt.slice(0, 297) + "...";
    }
    return excerpt;
  }
  if (pluginContent) {
    return generateSummary(pluginContent.html) || null;
  }
  if (markdownResult) {
    return generateSummary(html) || null;
  }
  return null;
}
