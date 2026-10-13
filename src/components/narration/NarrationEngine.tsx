/**
 * Runs `useNarration` for an article and reports it to the article view.
 *
 * Loaded with next/dynamic (see index.tsx) so the narration engine (speech
 * players, sentence splitting, paragraph mapping) stays out of the initial
 * bundle. Renders nothing; unmounting it stops narration.
 */

"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { processHtmlForHighlighting } from "@/lib/narration/client-paragraph-ids";
import { useNarration } from "./useNarration";
import type { NarrationEngineView, UseNarrationConfig } from "./useNarrationTypes";

interface NarrationEngineProps extends UseNarrationConfig {
  /** Receives the engine's view whenever it changes, and null on unmount */
  onChange: (view: NarrationEngineView | null) => void;
}

export function NarrationEngineImpl({ onChange, ...config }: NarrationEngineProps) {
  const narration = useNarration(config);

  // The hook's callbacks change identity on most renders; forwarding through a
  // ref keeps the reported controls stable, so reporting them can't loop.
  const latest = useRef(narration);
  useLayoutEffect(() => {
    latest.current = narration;
  });
  const controls = useMemo(
    () => ({
      play: () => latest.current.play(),
      pause: () => latest.current.pause(),
      skipForward: () => latest.current.skipForward(),
      skipBackward: () => latest.current.skipBackward(),
      playFromElement: (elementIndex: number) => latest.current.playFromElement(elementIndex),
      stop: () => latest.current.stop(),
    }),
    []
  );

  const { state, isSupported, processedHtml } = narration;
  const isHighlighting = isSupported && (processedHtml !== null || state.status !== "idle");
  const { content } = config;

  // Content is sanitized on the server (src/server/html/sanitize.ts), so this
  // only adds the highlighting markup. Client-side narration already produced
  // it (processedHtml), with ids that exactly match its paragraph map.
  const highlightHtml = useMemo(() => {
    if (!content || !isHighlighting) return null;
    return processedHtml ?? processHtmlForHighlighting(content);
  }, [content, isHighlighting, processedHtml]);

  // Layout effects, so the view re-renders with a new state before paint.
  useLayoutEffect(() => {
    onChange({
      ...controls,
      state,
      isSupported,
      processedHtml,
      isHighlighting,
      highlightHtml,
      highlightSource: content ?? null,
    });
  }, [
    onChange,
    controls,
    state,
    isSupported,
    processedHtml,
    isHighlighting,
    highlightHtml,
    content,
  ]);
  useLayoutEffect(() => () => onChange(null), [onChange]);

  return null;
}
