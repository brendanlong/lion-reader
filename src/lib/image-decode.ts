/**
 * Decode an image off-DOM and resolve once it's ready to paint (or a timeout
 * elapses).
 *
 * Paging to a new entry mounts brand-new `<img>` nodes, and a fresh `<img>`
 * never paints its bytes on the first frame even when they're cached — the
 * browser reserves the box, decodes, then paints a frame later, flashing the
 * alt text in between. Awaiting `HTMLImageElement.decode()` on an off-DOM
 * `Image` with the same `src` warms the browser's decoded-image cache, so the
 * on-DOM `<img>` that mounts next paints atomically instead of flashing.
 *
 * The wait is capped by `timeoutMs`: a cached hero decodes in ~20ms so
 * navigation is only briefly delayed, while an uncached or slow image resolves
 * on the timeout instead of stalling navigation. Rejections (e.g. a decode
 * aborted by a `src` change, or a load error) also resolve — the caller should
 * navigate regardless; the destination's own loading state handles failures.
 *
 * @param src - Image URL to decode.
 * @param timeoutMs - Maximum time to wait before resolving anyway.
 */
export function decodeImage(src: string, timeoutMs: number): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    const img = new Image();
    img.src = src;
    // decode() resolves when the bytes are decoded; it rejects if the load
    // fails or is aborted. Either way we're done waiting.
    img.decode().then(finish, finish);
  });
}
