/**
 * NarrationHighlightStyles Component
 *
 * Injects dynamic CSS to highlight paragraphs during narration playback.
 * This is a React-idiomatic approach that avoids direct DOM manipulation.
 *
 * Instead of querying DOM elements and adding/removing classes in useEffect,
 * this component renders a <style> element with CSS rules that target the
 * specific paragraph IDs that should be highlighted.
 *
 * @example
 * ```tsx
 * <NarrationHighlightStyles
 *   highlightedParagraph={highlightedParagraph}
 *   enabled={narrationSettings.highlightEnabled}
 * />
 * <div dangerouslySetInnerHTML={{ __html: content }} />
 * ```
 */

"use client";

import { useMemo } from "react";

/**
 * Props for NarrationHighlightStyles component.
 */
interface NarrationHighlightStylesProps {
  /** DOM element index (`para-N`) to highlight, or null for none */
  highlightedParagraph: number | null;
  /** Whether highlighting is enabled in settings */
  enabled: boolean;
  /** Whether clicking a paragraph narrates from it, so paragraphs should look clickable */
  seekable?: boolean;
}

/**
 * Generates CSS rules to highlight a paragraph by its data-para-id.
 *
 * Uses CSS attribute selectors to target elements without DOM queries.
 * Images get a border instead of background color since they have no text content.
 */
function generateHighlightCSS(paragraph: number): string {
  // The colors are per-theme tokens in globals.css.
  return `
[data-para-id="para-${paragraph}"]:not(img) {
  background-color: var(--narration-highlight);
  box-shadow: 0 0 0 var(--narration-highlight-edge) var(--narration-highlight-ring);
  border-radius: 0.25rem;
  transition: background-color 0.3s ease, box-shadow 0.3s ease;
  scroll-margin-top: 100px;
}

img[data-para-id="para-${paragraph}"] {
  box-shadow: 0 0 0 3px var(--narration-highlight-ring);
  border-radius: 0.25rem;
  transition: box-shadow 0.3s ease;
  scroll-margin-top: 100px;
}
`;
}

const SEEKABLE_CSS = `[data-para-id] { cursor: pointer; }`;

/**
 * Component that injects dynamic CSS for narration highlighting.
 *
 * This is a pure React approach - no DOM queries or class manipulation.
 * The highlighting is achieved by generating CSS rules that target
 * paragraphs by their data-para-id attribute.
 */
export function NarrationHighlightStyles({
  highlightedParagraph,
  enabled,
  seekable = false,
}: NarrationHighlightStylesProps) {
  const css = useMemo(() => {
    const highlight =
      enabled && highlightedParagraph !== null ? generateHighlightCSS(highlightedParagraph) : "";
    return seekable ? `${highlight}\n${SEEKABLE_CSS}` : highlight;
  }, [highlightedParagraph, enabled, seekable]);

  // Don't render anything if there's no CSS to inject
  if (!css) {
    return null;
  }

  // Inject the dynamic styles via a <style> element
  // This is React-controlled and updates reactively with state changes
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}
