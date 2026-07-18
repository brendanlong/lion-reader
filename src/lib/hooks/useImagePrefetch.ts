import { useEffect, useLayoutEffect } from "react";
import { useScrollContainer } from "@/components/layout/ScrollContainerContext";

// useLayoutEffect must run before paint (see below), but it warns when React
// renders on the server. The content it observes is client-rendered, so fall
// back to useEffect during SSR to stay quiet.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

// Applied to an <img> while it loads to hide its alt text/broken-image
// placeholder (see below). Kept in sync with the CSS rule in globals.css.
const IMG_LOADING_CLASS = "content-img-loading";

/**
 * Prefetch images before they scroll into view, and make images that are
 * already on-screen paint without a flash.
 *
 * Opening or paging an entry mounts brand-new `<img>` nodes, and a fresh `<img>`
 * never paints its bytes on the first frame — even when they're cached (service
 * worker / CDN / memory). By default the browser reserves the box, then decodes
 * `decoding="async"` off the critical path and paints the image a frame later;
 * for sanitizer-stamped `loading="lazy"` images the deferral is worse still.
 * Either way that empty→decode gap is the flash seen on every navigation despite
 * the 0ms cache hits.
 *
 * To fix it we split the images at mount:
 *   - Images actually in the viewport get `loading="eager"` + `decoding="sync"`
 *     **synchronously in a layout effect, before paint**, so the browser decodes
 *     a cached image and presents it atomically on the first paint instead of
 *     showing a blank box. This covers both lazy (sanitized feed content) and
 *     plain-eager images (e.g. the demo's raw, unsanitized HTML).
 *   - Lazy images below the fold keep the lazy path but are upgraded to eager via
 *     an IntersectionObserver as they approach, so they're decoded before they
 *     scroll in too. Non-lazy images below the fold already load eagerly.
 *
 * As a backstop for the frames before a not-yet-cached image paints, every
 * still-loading image gets a class that hides its alt text/broken-image
 * placeholder, so the reserved box stays empty instead of flashing alt text.
 * The class is removed on load (image paints) or error (alt text is revealed so
 * a genuinely broken image stays meaningful). The alt attribute is untouched, so
 * screen readers are unaffected — this only hides the *visual* placeholder.
 *
 * @param containerRef - Ref to the container element with images
 * @param content - The content string (used to re-run when content changes)
 * @param rootMargin - How far outside the viewport to start prefetching (default: "50%")
 */
export function useImagePrefetch(
  containerRef: React.RefObject<HTMLElement | null>,
  content: string | null,
  rootMargin = "50%"
) {
  // Get scroll container from context (provided by ScrollContainerProvider)
  const scrollContainerRef = useScrollContainer();

  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const images = Array.from(container.querySelectorAll<HTMLImageElement>("img"));
    if (images.length === 0) return;

    // Hide the alt-text/broken-image placeholder while each image loads, so the
    // reserved box stays empty for the frame(s) before it paints instead of
    // flashing alt text. Reveal it again on error (so a broken image stays
    // meaningful); on success the removed class just lets the painted image show
    // (alt text isn't visible over a loaded image anyway). Runs before paint in
    // the layout effect, so the class is present on the very first frame.
    const listenerCleanups: Array<() => void> = [];
    for (const img of images) {
      // A complete image is already settled: only reveal alt text if it failed
      // (a failed load reports complete with naturalWidth 0).
      if (img.complete) continue;

      img.classList.add(IMG_LOADING_CLASS);
      const reveal = () => img.classList.remove(IMG_LOADING_CLASS);
      img.addEventListener("load", reveal, { once: true });
      img.addEventListener("error", reveal, { once: true });
      listenerCleanups.push(() => {
        img.removeEventListener("load", reveal);
        img.removeEventListener("error", reveal);
      });
    }

    // The IntersectionObserver root: the scroll container, or the viewport.
    const root = scrollContainerRef?.current ?? null;
    const rootRect = root
      ? root.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight, height: window.innerHeight };

    // Only images actually on screen need the synchronous eager + sync-decode
    // treatment — that's the only place a blank frame is *visible*. Using a
    // wider margin here would mass-eager-load and sync-decode everything just
    // below the fold, which defeats lazy loading on long articles (feed images
    // often have no width/height, so they collapse to height 0 and stack near
    // the top before they load). Below-fold prefetch-ahead stays with the
    // observer, which upgrades lazy images to eager as they approach — without
    // sync decode, since they aren't visible yet.
    const toObserve: HTMLImageElement[] = [];
    for (const img of images) {
      const rect = img.getBoundingClientRect();
      const visible = rect.bottom >= rootRect.top && rect.top <= rootRect.bottom;
      if (visible) {
        img.loading = "eager";
        img.decoding = "sync";
      } else if (img.getAttribute("loading") === "lazy") {
        toObserve.push(img);
      }
    }

    const runListenerCleanups = () => {
      for (const cleanup of listenerCleanups) cleanup();
    };

    if (toObserve.length === 0) return runListenerCleanups;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;

          const img = entry.target as HTMLImageElement;

          // Stop observing this image
          observer.unobserve(img);

          // Change from lazy to eager loading to trigger immediate load
          img.loading = "eager";
        }
      },
      {
        // Use scroll container from context, or viewport if not available
        root,
        // Start observing when images are within rootMargin
        rootMargin,
        // Trigger as soon as any part enters the margin
        threshold: 0,
      }
    );

    // Observe remaining images (skip already loaded ones)
    for (const img of toObserve) {
      if (!img.complete) {
        observer.observe(img);
      }
    }

    return () => {
      observer.disconnect();
      runListenerCleanups();
    };
  }, [containerRef, content, rootMargin, scrollContainerRef]);
}
