/**
 * EntryContentOptions
 *
 * Per-mount customization of the entry reader, so a host that renders the real
 * `EntryContent` tree against different data (the public demo) can adjust what
 * the reader shows without a parallel reader implementation.
 */

"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PrerecordedVoice } from "@/lib/narration/prerecorded-speech";

export interface EntryContentSlots {
  /** Rendered between the header and the article body (after the summary card). */
  beforeContent?: ReactNode;
  /** Rendered after the article body, before the footer. */
  afterContent?: ReactNode;
}

export interface EntryContentOptions {
  /**
   * Narrate only with recordings made ahead of time in this voice, whatever
   * the visitor's narration settings say: for where there's no server to
   * synthesize speech.
   */
  prerecordedNarration?: PrerecordedVoice;
  /**
   * IANA zone the article date is formatted in during a *server* render. A
   * prerendered page can't know the visitor's zone; picking a likely one keeps
   * the post-hydration switch to local time a small correction rather than a
   * jump from UTC. Client renders always use the visitor's zone.
   */
  ssrDateTimeZone?: string;
  /** Extra content to render around a specific entry's body. */
  renderSlots?: (entryId: string) => EntryContentSlots | undefined;
}

const EntryContentOptionsContext = createContext<EntryContentOptions>({});

export function EntryContentOptionsProvider({
  value,
  children,
}: {
  value: EntryContentOptions;
  children: ReactNode;
}) {
  return (
    <EntryContentOptionsContext.Provider value={value}>
      {children}
    </EntryContentOptionsContext.Provider>
  );
}

export function useEntryContentOptions(): EntryContentOptions {
  return useContext(EntryContentOptionsContext);
}
