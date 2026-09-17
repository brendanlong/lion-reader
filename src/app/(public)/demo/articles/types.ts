/**
 * Type for individual demo article files.
 *
 * Each article specifies its own subscription, starred status, and published date.
 * The main data.ts file generates everything else (entry counts, feedTitle, etc.).
 */
export interface DemoArticle {
  id: string;
  subscriptionId: string;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string;
  author: string | null;
  summary: string;
  publishedAt: Date;
  starred: boolean;
  contentHtml: string;
  /** Pre-generated AI summary HTML (from Claude Sonnet) for the demo summary card */
  summaryHtml: string;
  /**
   * Model ID that generated `summaryHtml`, shown in the summary card footer via
   * `formatModelName` (e.g. "claude-sonnet-5" -> "Claude Sonnet 5"). Set this to
   * the Sonnet model the summary was actually generated with — summaries written
   * on or before 2026-06-30 used `claude-sonnet-4-6`; later ones use
   * `claude-sonnet-5`.
   */
  summaryModelId: string;
  /**
   * When `summaryHtml` was generated (the date it was written/last regenerated,
   * per git history). Rendered in the summary card footer.
   */
  summaryGeneratedAt: Date;
}
