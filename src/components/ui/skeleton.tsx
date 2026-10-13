/**
 * Loading placeholder for a line of text.
 *
 * Put it where the text will render, under the same font-size and color
 * classes: it takes that line's exact height (`1lh`) and draws a faint bar in
 * the text's own color, so a white sidebar label loads as a faint white line
 * and the swap to real text moves nothing. Placeholders for other things
 * should be the real element's chrome (a disabled button, an empty card), not
 * a gray box.
 *
 * The line fades in after a short delay, so a load that finishes quickly never
 * flashes a placeholder. E-paper gets a static gray bar: the panel can't
 * animate, and a tinted text color would dither.
 */
export function SkeletonText({
  width,
  className = "",
}: {
  /** Width of the bar, e.g. `w-3/4` */
  width: string;
  /** Classes for the line box, e.g. `inline-flex w-32` to sit inline */
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`motion-safe:animate-skeleton-in epaper:animate-none flex h-[1lh] items-center ${className}`}
    >
      <span
        className={`motion-safe:animate-skeleton epaper:bg-fill-muted epaper:animate-none h-[0.6em] rounded-full bg-current/15 ${width}`}
      />
    </span>
  );
}
