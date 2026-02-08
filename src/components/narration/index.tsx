/**
 * NarrationControls dynamic import wrapper.
 *
 * NarrationControls depends on browser-only APIs (speechSynthesis, localStorage).
 * Using ssr: false avoids hydration mismatches and the flash of the button appearing.
 * The skeleton placeholder prevents layout shift while the component loads.
 *
 * NOTE: EnhancedVoiceList and useEnhancedVoices depend on piper-tts-web which has
 * Node.js-only code (require('fs')) that breaks client bundling. Import them directly
 * from their files if needed, and use next/dynamic with ssr: false for components.
 */

import dynamic from "next/dynamic";

function NarrationControlsSkeleton() {
  return (
    <div className="min-h-[36px] w-[88px] animate-pulse rounded-lg bg-zinc-100 sm:min-h-[32px] dark:bg-zinc-800" />
  );
}

export const NarrationControls = dynamic(
  () => import("./NarrationControls").then((mod) => mod.NarrationControlsImpl),
  { ssr: false, loading: () => <NarrationControlsSkeleton /> }
);
