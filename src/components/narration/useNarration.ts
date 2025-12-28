/**
 * useNarration Hook
 *
 * Manages article narration state using the Web Speech API.
 * Handles narration generation, playback controls, and Media Session integration.
 *
 * Usage:
 * ```tsx
 * function ArticleView({ articleId }: { articleId: string }) {
 *   const narration = useNarration({ id: articleId, type: 'entry', title: 'Article Title', feedTitle: 'Feed' });
 *
 *   return (
 *     <NarrationControls
 *       state={narration.state}
 *       isLoading={narration.isLoading}
 *       onPlay={narration.play}
 *       onPause={narration.pause}
 *       onSkipForward={narration.skipForward}
 *       onSkipBackward={narration.skipBackward}
 *     />
 *   );
 * }
 * ```
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { trpc } from "@/lib/trpc/client";
import { ArticleNarrator, type NarrationState } from "@/lib/narration/ArticleNarrator";
import { useNarrationSettings } from "@/lib/narration/settings";
import { findVoiceByUri, waitForVoices } from "@/lib/narration/voices";
import {
  setupMediaSession,
  clearMediaSession,
  createMediaSessionStateHandler,
} from "@/lib/narration/media-session";
import { isNarrationSupported } from "@/lib/narration/feature-detection";

/**
 * Configuration for the useNarration hook.
 */
export interface UseNarrationConfig {
  /** The article ID (entry or saved article) */
  id: string;
  /** Type of article: 'entry' for feed entries, 'saved' for saved articles */
  type: "entry" | "saved";
  /** Title of the article (for Media Session) */
  title: string;
  /** Feed or site name (for Media Session) */
  feedTitle: string;
  /** Optional artwork URL for Media Session */
  artwork?: string;
}

/**
 * Return type for the useNarration hook.
 */
export interface UseNarrationReturn {
  /** Current narration state */
  state: NarrationState;
  /** Whether narration text is being generated */
  isLoading: boolean;
  /** Start or resume playback */
  play: () => void;
  /** Pause playback */
  pause: () => void;
  /** Skip to the next paragraph */
  skipForward: () => void;
  /** Skip to the previous paragraph */
  skipBackward: () => void;
  /** Stop playback and reset to beginning */
  stop: () => void;
  /** Whether narration is supported in this browser */
  isSupported: boolean;
}

/**
 * Default narration state when no article is loaded.
 */
const DEFAULT_STATE: NarrationState = {
  status: "idle",
  currentParagraph: 0,
  totalParagraphs: 0,
  selectedVoice: null,
};

/**
 * Hook for managing article narration.
 *
 * Handles:
 * - Generating narration text via the API
 * - Managing the ArticleNarrator instance
 * - Integrating with Media Session API
 * - Using user's voice/rate/pitch preferences
 *
 * @param config - Configuration including article ID, type, and metadata
 * @returns Object with narration state and control functions
 */
export function useNarration(config: UseNarrationConfig): UseNarrationReturn {
  const { id, type, title, feedTitle, artwork } = config;

  // State
  const [state, setState] = useState<NarrationState>(DEFAULT_STATE);
  const [isLoading, setIsLoading] = useState(false);
  const [narrationText, setNarrationText] = useState<string | null>(null);
  const [isSupported] = useState(() => isNarrationSupported());

  // Refs
  const narratorRef = useRef<ArticleNarrator | null>(null);
  const mediaSessionUnsubscribeRef = useRef<(() => void) | null>(null);

  // Get user settings
  const [settings] = useNarrationSettings();

  // tRPC mutation for generating narration
  const generateMutation = trpc.narration.generate.useMutation();

  // Initialize narrator instance
  useEffect(() => {
    if (!isSupported) return;

    narratorRef.current = new ArticleNarrator();

    // Subscribe to state changes
    const unsubscribe = narratorRef.current.onStateChange((newState) => {
      setState(newState);
    });

    return () => {
      unsubscribe();
      narratorRef.current?.stop();
      narratorRef.current = null;
    };
  }, [isSupported]);

  // Set up Media Session when we have narration text
  useEffect(() => {
    if (!isSupported || !narrationText || !narratorRef.current) return;

    // Set up Media Session
    setupMediaSession({
      articleTitle: title,
      feedTitle: feedTitle,
      narrator: narratorRef.current,
      artwork,
    });

    // Subscribe to state changes for Media Session updates
    const stateHandler = createMediaSessionStateHandler();
    mediaSessionUnsubscribeRef.current = narratorRef.current.onStateChange(stateHandler);

    return () => {
      clearMediaSession();
      if (mediaSessionUnsubscribeRef.current) {
        mediaSessionUnsubscribeRef.current();
        mediaSessionUnsubscribeRef.current = null;
      }
    };
  }, [isSupported, narrationText, title, feedTitle, artwork]);

  // Apply user settings when they change
  useEffect(() => {
    if (!narratorRef.current) return;

    narratorRef.current.setRate(settings.rate);
    narratorRef.current.setPitch(settings.pitch);
  }, [settings.rate, settings.pitch]);

  // Get the voice from settings when it changes
  useEffect(() => {
    if (!isSupported || !narratorRef.current) return;

    async function updateVoice() {
      if (settings.voiceId) {
        // Wait for voices to be available, then find the selected one
        await waitForVoices();
        const voice = findVoiceByUri(settings.voiceId);
        if (voice) {
          narratorRef.current?.setVoice(voice);
        }
      }
    }

    updateVoice();
  }, [isSupported, settings.voiceId]);

  /**
   * Start or resume playback.
   * If narration hasn't been generated yet, generates it first.
   */
  const play = useCallback(async () => {
    if (!isSupported || !narratorRef.current) return;

    const narrator = narratorRef.current;

    // If paused, just resume
    if (state.status === "paused") {
      narrator.resume();
      return;
    }

    // If already playing, do nothing
    if (state.status === "playing") return;

    // If we already have narration text loaded, just play
    if (narrationText && state.totalParagraphs > 0) {
      // Get the voice if we have a preference
      let voice: SpeechSynthesisVoice | undefined;
      if (settings.voiceId) {
        const foundVoice = findVoiceByUri(settings.voiceId);
        if (foundVoice) {
          voice = foundVoice;
        }
      }
      narrator.play(voice, settings.rate, settings.pitch);
      return;
    }

    // Need to generate narration
    setIsLoading(true);
    setState((prev) => ({ ...prev, status: "loading" }));

    try {
      const result = await generateMutation.mutateAsync({ id, type });

      if (result.narration) {
        setNarrationText(result.narration);
        narrator.loadArticle(result.narration);

        // Wait for voices and get preferred voice
        await waitForVoices();
        let voice: SpeechSynthesisVoice | undefined;
        if (settings.voiceId) {
          const foundVoice = findVoiceByUri(settings.voiceId);
          if (foundVoice) {
            voice = foundVoice;
          }
        }

        // Start playback
        narrator.play(voice, settings.rate, settings.pitch);
      }
    } catch (error) {
      console.error("Failed to generate narration:", error);
      setState((prev) => ({ ...prev, status: "idle" }));
    } finally {
      setIsLoading(false);
    }
  }, [
    isSupported,
    state.status,
    state.totalParagraphs,
    narrationText,
    settings.voiceId,
    settings.rate,
    settings.pitch,
    generateMutation,
    id,
    type,
  ]);

  /**
   * Pause playback.
   */
  const pause = useCallback(() => {
    if (!isSupported || !narratorRef.current) return;
    narratorRef.current.pause();
  }, [isSupported]);

  /**
   * Skip to the next paragraph.
   */
  const skipForward = useCallback(() => {
    if (!isSupported || !narratorRef.current) return;
    narratorRef.current.skipForward();
  }, [isSupported]);

  /**
   * Skip to the previous paragraph.
   */
  const skipBackward = useCallback(() => {
    if (!isSupported || !narratorRef.current) return;
    narratorRef.current.skipBackward();
  }, [isSupported]);

  /**
   * Stop playback and reset to beginning.
   */
  const stop = useCallback(() => {
    if (!isSupported || !narratorRef.current) return;
    narratorRef.current.stop();
  }, [isSupported]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      narratorRef.current?.stop();
      clearMediaSession();
    };
  }, []);

  return {
    state,
    isLoading,
    play,
    pause,
    skipForward,
    skipBackward,
    stop,
    isSupported,
  };
}
