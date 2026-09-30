/**
 * Which element a click on an article asks narration to seek to — shared by the
 * web reader and the native app's reader so taps mean the same thing in both.
 *
 * @module narration/seek-target
 */

/** Content whose clicks already do something, so they never seek narration */
const NON_SEEK_TARGETS = "a, button, input, select, textarea, summary, label, video, audio, iframe";

/**
 * The narration element index (`data-para-id`) a click seeks to, or null when
 * the click means something else: following a link or using a control,
 * selecting text (a multi-click), or dismissing a selection. Whether a selection
 * existed has to be captured on `pointerdown` and passed in, because the press
 * that dismisses one collapses it before `click` fires.
 */
export function seekTargetElement(
  event: { target: EventTarget | null; detail: number },
  hadSelectionAtPointerDown: boolean
): number | null {
  if (!(event.target instanceof Element)) return null;
  if (event.target.closest(NON_SEEK_TARGETS)) return null;
  if (event.detail > 1 || hadSelectionAtPointerDown) return null;
  if (window.getSelection()?.isCollapsed === false) return null;

  const paraId = event.target.closest("[data-para-id]")?.getAttribute("data-para-id");
  const elementIndex = paraId ? Number(paraId.replace("para-", "")) : NaN;
  return Number.isInteger(elementIndex) ? elementIndex : null;
}
