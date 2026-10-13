/**
 * Dynamic import wrappers for the narration controls and engine.
 *
 * Both depend on browser-only APIs (speechSynthesis, localStorage, Media
 * Source), so they load with ssr: false: no hydration mismatch, and the engine
 * stays out of the initial bundle until an article with narration enabled is
 * open. The skeleton placeholder prevents layout shift while they load.
 *
 * NOTE: EnhancedVoiceList and useEnhancedVoices depend on piper-tts-web which has
 * Node.js-only code (require('fs')) that breaks client bundling. Import them directly
 * from their files if needed, and use next/dynamic with ssr: false for components.
 */

import dynamic from "next/dynamic";
import type { UseNarrationReturn } from "./useNarrationTypes";

function NarrationControlsSkeleton() {
  return (
    <div className="bg-fill-muted min-h-[36px] w-[88px] animate-pulse rounded-lg sm:min-h-[32px]" />
  );
}

const LazyNarrationControls = dynamic(
  () => import("./NarrationControls").then((mod) => mod.NarrationControlsImpl),
  { ssr: false, loading: () => <NarrationControlsSkeleton /> }
);

/** The narration controls, or their skeleton until the engine has loaded. */
export function NarrationControls({ narration }: { narration: UseNarrationReturn | null }) {
  return narration ? (
    <LazyNarrationControls narration={narration} />
  ) : (
    <NarrationControlsSkeleton />
  );
}

export const NarrationEngine = dynamic(
  () => import("./NarrationEngine").then((mod) => mod.NarrationEngineImpl),
  { ssr: false }
);
