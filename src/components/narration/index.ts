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

export { NarrationSettings } from "./NarrationSettings";
export { NarrationControls, type NarrationControlsProps } from "./NarrationControls";
export { useNarration, type UseNarrationConfig, type UseNarrationReturn } from "./useNarration";
export {
  useNarrationHighlight,
  computeHighlightedParagraphs,
  type UseNarrationHighlightProps,
  type UseNarrationHighlightResult,
  type ParagraphMapEntry,
} from "./useNarrationHighlight";
export { EnhancedVoicesHelp } from "./EnhancedVoicesHelp";
