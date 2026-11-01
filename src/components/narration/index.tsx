/**
 * Dynamic import wrappers for the narration controls and engine.
 *
 * Both depend on browser-only APIs (speechSynthesis, localStorage, Media
 * Source), so they load with ssr: false: no hydration mismatch, and the engine
 * stays out of the initial bundle until an article with narration enabled is
 * open. Until then a disabled copy of the idle button holds their place.
 */

import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { NarrationIcon } from "@/components/ui/icons";
import type { UseNarrationReturn } from "./useNarrationTypes";

/**
 * The idle "Listen" button, disabled, as the controls render before playback
 * starts; enabling it is the only change once they load.
 */
export function NarrationControlsSkeleton() {
  return (
    <Button variant="secondary" size="sm" disabled aria-label="Listen (loading)">
      <NarrationIcon />
      <span className="ml-2">Listen</span>
    </Button>
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
