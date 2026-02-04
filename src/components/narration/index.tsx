/**
 * Narration Components
 *
 * Re-export all narration components for convenient imports.
 *
 * NOTE: EnhancedVoiceList and useEnhancedVoices are intentionally NOT exported here.
 * They depend on piper-tts-web which has Node.js-only code (require('fs')) that
 * breaks client bundling. Import them directly from their files if needed,
 * and use next/dynamic with ssr: false for components.
 */

import dynamic from "next/dynamic";

/**
 * Skeleton placeholder for NarrationControls while it loads client-side.
 * Matches the dimensions of the "Listen" button (secondary variant, sm size).
 */
function NarrationControlsSkeleton() {
  return (
    <div className="min-h-[36px] w-[88px] animate-pulse rounded-lg bg-zinc-100 sm:min-h-[32px] dark:bg-zinc-800" />
  );
}

// NarrationControls depends on browser-only APIs (speechSynthesis, localStorage).
// Using ssr: false avoids hydration mismatches and the flash of the button appearing.
// The skeleton placeholder prevents layout shift while the component loads.
export const NarrationControls = dynamic(
  () => import("./NarrationControls").then((mod) => mod.NarrationControlsImpl),
  { ssr: false, loading: () => <NarrationControlsSkeleton /> }
);
export { useNarration } from "./useNarration";
export { useNarrationHighlight } from "./useNarrationHighlight";
export { NarrationHighlightStyles } from "./NarrationHighlightStyles";
