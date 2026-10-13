/**
 * Styles for entry text (article content, summaries, the settings preview).
 *
 * They read the `--entry-*` CSS vars that the appearance head script sets before
 * first paint and the settings store updates on change (see `./config.ts`), so
 * they're constant: the user's settings never reach React.
 */

import type { CSSProperties } from "react";

/** Prose classes for entry content. */
export const ENTRY_TEXT_CLASS_NAME = "prose prose-zinc dark:prose-invert";

/** Inline font/size/alignment style for entry text, from the `--entry-*` vars. */
export const ENTRY_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--entry-font-family, inherit)",
  fontSize: "var(--entry-font-size, 1rem)",
  lineHeight: "var(--entry-line-height, 1.7)",
  textAlign: "var(--entry-text-align, left)" as CSSProperties["textAlign"],
};
