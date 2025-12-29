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
 *   highlightedParagraphIds={highlightedParagraphIds}
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
  /** Set of paragraph indices that should be highlighted */
  highlightedParagraphIds: Set<number>;
  /** Whether highlighting is enabled in settings */
  enabled: boolean;
}

/**
 * Generates CSS rules to highlight specific paragraphs by their data-para-id.
 *
 * Uses CSS attribute selectors to target elements without DOM queries.
 */
function generateHighlightCSS(paragraphIds: Set<number>): string {
  if (paragraphIds.size === 0) {
    return "";
  }

  // Build selector for all highlighted paragraph IDs
  const selectors = Array.from(paragraphIds)
    .map((id) => `[data-para-id="para-${id}"]`)
    .join(",\n");

  // Return CSS rules that apply the highlight styles
  // These styles match globals.css .narration-highlight class
  return `
${selectors} {
  background-color: rgba(253, 230, 138, 0.3);
  border-radius: 0.25rem;
  transition: background-color 0.3s ease;
  scroll-margin-top: 100px;
}

.dark ${selectors} {
  background-color: rgba(113, 63, 18, 0.3);
}

@media (prefers-color-scheme: dark) {
  ${selectors} {
    background-color: rgba(113, 63, 18, 0.3);
  }
}
`;
}

/**
 * Component that injects dynamic CSS for narration highlighting.
 *
 * This is a pure React approach - no DOM queries or class manipulation.
 * The highlighting is achieved by generating CSS rules that target
 * paragraphs by their data-para-id attribute.
 */
export function NarrationHighlightStyles({
  highlightedParagraphIds,
  enabled,
}: NarrationHighlightStylesProps) {
  const css = useMemo(() => {
    if (!enabled || highlightedParagraphIds.size === 0) {
      return "";
    }
    return generateHighlightCSS(highlightedParagraphIds);
  }, [highlightedParagraphIds, enabled]);

  // Don't render anything if there's no CSS to inject
  if (!css) {
    return null;
  }

  // Inject the dynamic styles via a <style> element
  // This is React-controlled and updates reactively with state changes
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}
