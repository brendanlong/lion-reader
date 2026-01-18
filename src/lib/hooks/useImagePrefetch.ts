import { useEffect } from "react";
import { useScrollContainer } from "@/components/layout/ScrollContainerContext";

/**
 * Prefetch images before they scroll into view.
 *
 * Uses IntersectionObserver with a large rootMargin to detect images
 * approaching the viewport and start loading them early, preventing
 * the flash that occurs with native `loading="lazy"`.
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Find all lazy-loaded images in the container
    const images = container.querySelectorAll<HTMLImageElement>('img[loading="lazy"]');
    if (images.length === 0) return;

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
        root: scrollContainerRef?.current ?? null,
        // Start observing when images are within rootMargin
        rootMargin,
        // Trigger as soon as any part enters the margin
        threshold: 0,
      }
    );

    // Observe all lazy images (skip already loaded ones)
    images.forEach((img) => {
      if (!img.complete) {
        observer.observe(img);
      }
    });

    return () => {
      observer.disconnect();
    };
  }, [containerRef, content, rootMargin, scrollContainerRef]);
}
