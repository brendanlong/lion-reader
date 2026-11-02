"use client";

import { createStoredChoice } from "@/lib/stored-preference";

/**
 * When the reader marks an article read by itself, on this device: as it
 * opens, once it's finished (its last line seen, or narration done with its
 * text), or never. The Android app's `MarkReadOn` is the same setting.
 */
const MARK_READ_ON = ["opened", "finished", "never"] as const;
export type MarkReadOn = (typeof MARK_READ_ON)[number];

const store = createStoredChoice<MarkReadOn>("lion-reader:mark-read-on", MARK_READ_ON, "opened");

export function useMarkReadOn(): [MarkReadOn, (value: MarkReadOn) => void] {
  return [store.useValue(), store.set];
}
