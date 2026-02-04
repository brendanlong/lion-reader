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

// NarrationControls depends on browser-only APIs (speechSynthesis, localStorage).
// Using ssr: false avoids hydration mismatches and the flash of the button appearing.
export const NarrationControls = dynamic(
  () => import("./NarrationControls").then((mod) => mod.NarrationControlsImpl),
  { ssr: false }
);
export { useNarration } from "./useNarration";
export { useNarrationHighlight } from "./useNarrationHighlight";
export { NarrationHighlightStyles } from "./NarrationHighlightStyles";
