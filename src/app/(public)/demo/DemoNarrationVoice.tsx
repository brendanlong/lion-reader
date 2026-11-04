/**
 * The voice the demo's narration is recorded in, from the server's config
 * (`getDemoNarrationVoice`), rendered into the prerendered demo pages by
 * their layout, or null for the browser's voices.
 */

"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PrerecordedVoice } from "@/lib/narration/prerecorded-speech";

const DemoNarrationVoiceContext = createContext<PrerecordedVoice | null>(null);

export function DemoNarrationVoiceProvider({
  voice,
  children,
}: {
  voice: PrerecordedVoice | null;
  children: ReactNode;
}) {
  return <DemoNarrationVoiceContext value={voice}>{children}</DemoNarrationVoiceContext>;
}

export function useDemoNarrationVoice(): PrerecordedVoice | null {
  return useContext(DemoNarrationVoiceContext);
}
