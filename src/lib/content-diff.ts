import { z } from "zod";

/**
 * Compact representation of how to reconstruct one HTML body from another.
 *
 * Feed plugins (e.g. LessWrong, whose cleaner only strips a "Published on
 * [date]" prefix) produce a `contentCleaned` that differs from
 * `contentOriginal` by a single small contiguous edit. Shipping both full
 * bodies from `entries.get` roughly doubles the payload for such entries while
 * the renderer only ever shows one at a time. Instead we ship the displayed
 * body (cleaned) in full plus this diff, and reconstruct the original on the
 * client only when the user toggles "Show Original" — preserving the
 * one-round-trip load while removing the near-duplicate copy.
 *
 * The diff stores the lengths of the shared prefix/suffix between the two
 * bodies and only the differing middle of the target. When the two bodies
 * diverge a lot (e.g. a saved article's raw page vs. its Readability extract)
 * the middle approaches the full target, so this never costs more than sending
 * the target outright.
 */
export const contentDiffSchema = z.object({
  /** Length of the common prefix shared with the base body. */
  prefixLen: z.number().int().nonnegative(),
  /** Length of the common suffix shared with the base body. */
  suffixLen: z.number().int().nonnegative(),
  /** The target body's differing middle segment. */
  middle: z.string(),
});

export type ContentDiff = z.infer<typeof contentDiffSchema>;

/**
 * Compute a diff that reconstructs `target` from `base`.
 *
 * Finds the longest common prefix and (non-overlapping) suffix of the two
 * strings and records only the target's differing middle.
 */
export function computeContentDiff(base: string, target: string): ContentDiff {
  const maxLen = Math.min(base.length, target.length);

  let prefixLen = 0;
  while (prefixLen < maxLen && base[prefixLen] === target[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < maxLen - prefixLen &&
    base[base.length - 1 - suffixLen] === target[target.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  return {
    prefixLen,
    suffixLen,
    middle: target.slice(prefixLen, target.length - suffixLen),
  };
}

/**
 * Reconstruct the target body from `base` and a diff produced by
 * {@link computeContentDiff}.
 */
export function applyContentDiff(base: string, diff: ContentDiff): string {
  return base.slice(0, diff.prefixLen) + diff.middle + base.slice(base.length - diff.suffixLen);
}
