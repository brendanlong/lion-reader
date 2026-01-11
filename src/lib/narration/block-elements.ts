/**
 * Shared block element definitions for narration.
 *
 * This module is isomorphic (works in both browser and server)
 * and provides the canonical list of block elements for paragraph marking.
 *
 * @module narration/block-elements
 */

/**
 * Block-level elements that get paragraph markers for narration highlighting.
 * Used by both server-side preprocessing and client-side highlighting.
 */
export const BLOCK_ELEMENTS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "li",
  "figure",
  "table",
  "img",
] as const;

/**
 * Type for block element tag names.
 */
export type BlockElement = (typeof BLOCK_ELEMENTS)[number];
