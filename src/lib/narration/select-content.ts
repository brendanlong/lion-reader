/**
 * Selects which stored content variant is currently on screen.
 *
 * Narration must read aloud (and highlight against) exactly the HTML the user is
 * looking at. The entry view can show one of three variants — fetched full
 * content, cleaned feed content, or the original feed content — chosen by the
 * `fetchFullContent`/"show original" toggles. This selector is the single source
 * of truth for that choice, shared by the renderer (`EntryContentBody`) and the
 * narration router, so the server narrates the same variant the client displays
 * and the paragraph map's element indices line up with the rendered DOM.
 *
 * @module narration/select-content
 */

export interface NarrationContentFields {
  fullContentCleaned?: string | null;
  fullContentOriginal?: string | null;
  contentCleaned: string | null;
  contentOriginal: string | null;
}

export interface NarrationContentView {
  /** Full (fetched-from-URL) content is being shown. */
  showFullContent: boolean;
  /** The original (uncleaned) feed content is being shown. */
  showOriginal: boolean;
}

/**
 * Returns the content variant currently displayed, mirroring the priority in
 * `EntryContentBody`: full content > cleaned feed content > original feed
 * content, with "show original" forcing the original variant.
 */
export function selectDisplayedContent(
  fields: NarrationContentFields,
  view: NarrationContentView
): string | null {
  if (view.showFullContent) {
    return fields.fullContentCleaned ?? fields.fullContentOriginal ?? null;
  }
  if (view.showOriginal) {
    return fields.contentOriginal;
  }
  return fields.contentCleaned ?? fields.contentOriginal;
}
