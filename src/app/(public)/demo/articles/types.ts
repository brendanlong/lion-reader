import type { StaticImageData } from "next/image";

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
   * Optional hero illustration, imported from `./images/` (e.g.
   * `import heroImage from "./images/text-to-speech.png"`) so Next content-hashes
   * it into `/_next/static` and serves it immutable from the CDN — no manual
   * cache-busting. Rendered at the top of the article; generate it at ~1200x630.
   * See src/app/demo/articles/CLAUDE.md for the house style.
   *
   * The social/OG preview uses the opaque `-og.png` sibling (`ogImage`) instead:
   * transparent heroes flatten unpredictably on social cards, so heroes may be
   * transparent while their OG variant bakes in a background.
   */
  heroImage?: StaticImageData;
  /**
   * The opaque social/OG preview image, imported from `./images/` (the `-og.png`
   * sibling of the hero — an opaque 1200x630 variant). Imported explicitly per
   * article rather than derived, so the build fails if it's missing.
   */
  ogImage?: StaticImageData;
  /** Alt text for heroImage; falls back to "<title> illustration" when omitted. */
  heroImageAlt?: string;
}
