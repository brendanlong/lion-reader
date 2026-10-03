/**
 * useNarration Hook
 *
 * Manages article narration state using the Web Speech API (browser voices),
 * Piper TTS (enhanced voices), or server-synthesized cloud voices. Handles
 * narration generation, playback controls, and Media Session integration.
 *
 * The owning component holds the hook (it also needs `state.currentParagraph`
 * for highlighting) and hands the whole thing to the controls:
 *
 * ```tsx
 * function ArticleView({ articleId }: { articleId: string }) {
 *   const narration = useNarration({ id: articleId, title: 'Article Title', feedTitle: 'Feed' });
 *
 *   return <NarrationControls narration={narration} />;
 * }
 * ```
 */

"use client";

import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { ArticleNarrator } from "@/lib/narration/ArticleNarrator";
import { useNarrationSettings } from "@/lib/narration/settings";
import { findVoiceByUri, waitForVoices } from "@/lib/narration/voices";
import { isNarrationSupported } from "@/lib/narration/feature-detection";
import {
  primeMediaSessionAudio,
  releasePrimedMediaSessionAudio,
} from "@/lib/narration/media-session";
import { useMediaSession } from "./useMediaSession";
import { trackNarrationPlaybackStarted } from "@/lib/telemetry";
import type {
  MediaSourcePlayer,
  PlaybackPosition,
  PlaybackStatus,
  PlayerCallbacks,
} from "@/lib/narration/media-source-player";
import {
  createCloudSpeechPlayer,
  createPrerecordedSpeechPlayer,
} from "@/lib/narration/cloud-speech";
import { getMediaSourceClass } from "@/lib/narration/media-source-player";
import type { PrerecordedVoice } from "@/lib/narration/prerecorded-speech";
import type { NarrationSettings } from "@/lib/narration/settings";
import { createPiperSpeechPlayer } from "@/lib/narration/piper-speech";
import { isEnhancedVoice } from "@/lib/narration/enhanced-voices";
import {
  htmlToClientNarration,
  type ParagraphMapEntry,
} from "@/lib/narration/client-paragraph-ids";
import {
  narrationParagraphForElement,
  splitNarrationParagraphs,
} from "@/lib/narration/paragraph-map";
import type { NarrationStatus } from "@/lib/narration/types";
import {
  type UseNarrationConfig,
  type UseNarrationReturn,
  type UseNarrationState,
  DEFAULT_NARRATION_STATE,
  getNarrationPhase,
} from "./useNarrationTypes";

/**
 * The settings recordings were made with, which the visitor's can't change:
 * only those that apply at playback (rate, highlighting) are theirs.
 */
function withPrerecordedVoice(
  settings: NarrationSettings,
  voice: PrerecordedVoice
): NarrationSettings {
  return {
    ...settings,
    provider: "cloud",
    cloudModelId: voice.model,
    voiceId: voice.voice,
    cloudPauseSeconds: voice.pauseSeconds,
    // Recorded from the text the client derives itself, not an LLM's script.
    useLlmNormalization: false,
  };
}

/** Recordings are found by a SHA-256 of their text, which needs a secure context. */
function canPlayPrerecordedSpeech(): boolean {
  return getMediaSourceClass() !== null && typeof crypto !== "undefined" && !!crypto.subtle;
}

function cancelPendingPlay(playRequest: { current: number }): void {
  playRequest.current++;
}

// Re-export types for consumers
export type { UseNarrationConfig, UseNarrationReturn };

/** The state as the players report it; "generating" is the hook's own. */
interface PlayerState extends Omit<UseNarrationState, "status"> {
  status: PlaybackStatus;
}

/**
 * Hook for managing article narration.
 *
 * Handles:
 * - Generating narration text via the API
 * - Managing the ArticleNarrator instance (for browser voices)
 * - Managing Piper TTS playback (for enhanced voices)
 * - Integrating with Media Session API
 * - Using user's voice/rate/pitch preferences
 *
 * @param config - Configuration including article ID and metadata
 * @returns Object with narration state and control functions
 */
export function useNarration(config: UseNarrationConfig): UseNarrationReturn {
  const {
    id,
    title,
    feedTitle,
    artwork,
    content,
    showFullContent,
    showOriginal,
    prerecordedVoice,
  } = config;

  // State
  const [playerState, setPlayerState] = useState<PlayerState>(DEFAULT_NARRATION_STATE);
  const [isGenerating, setIsGenerating] = useState(false);
  const [narrationText, setNarrationText] = useState<string | null>(null);
  // Defer browser support check until after hydration to avoid SSR mismatch
  // useSyncExternalStore ensures the check runs after hydration without cascading renders
  const isSupported = useSyncExternalStore(
    () => () => {}, // No subscription needed - browser capabilities don't change
    () => (prerecordedVoice ? canPlayPrerecordedSpeech() : isNarrationSupported()), // Client snapshot
    () => false // Server snapshot - always false during SSR
  );
  const [processedHtml, setProcessedHtml] = useState<string | null>(null);

  // Refs
  const narratorRef = useRef<ArticleNarrator | null>(null);

  // Piper and cloud voices each stream through their own Media Source player.
  const piperPlayerRef = useRef<MediaSourcePlayer | null>(null);
  const cloudPlayerRef = useRef<MediaSourcePlayer | null>(null);
  // Bumped by pause/stop/article changes, so a play() still generating
  // narration when the user moves on doesn't store or start it (see play()).
  const playRequestRef = useRef(0);
  // Counts narration loads, so only the latest one clears the generating flag.
  const loadRequestRef = useRef(0);
  // Track if we've already set up playback tracking for this session
  const hasTrackedPlaybackRef = useRef(false);
  // Paragraph mapping for translating narration indices to DOM element indices
  const paragraphMapRef = useRef<ParagraphMapEntry[]>([]);

  const [storedSettings] = useNarrationSettings();
  const settings = useMemo(
    () =>
      prerecordedVoice ? withPrerecordedVoice(storedSettings, prerecordedVoice) : storedSettings,
    [storedSettings, prerecordedVoice]
  );

  // Determine if we should use Piper provider
  const usePiper =
    settings.provider === "piper" && settings.voiceId && isEnhancedVoice(settings.voiceId);
  const useCloud = settings.provider === "cloud";
  // Piper and cloud voices drive their own player; browser voices use ArticleNarrator.
  const usesBufferedPlayer = usePiper || useCloud;

  // tRPC mutation for generating narration
  const generateMutation = trpc.narration.generate.useMutation();

  // The players outlive renders, so they read the current voice settings here.
  const voiceRef = useRef({
    model: settings.cloudModelId,
    voice: settings.voiceId,
    sentenceGapSeconds: settings.sentenceGapSeconds,
    cloudPauseSeconds: settings.cloudPauseSeconds,
  });
  useEffect(() => {
    voiceRef.current = {
      model: settings.cloudModelId,
      voice: settings.voiceId,
      sentenceGapSeconds: settings.sentenceGapSeconds,
      cloudPauseSeconds: settings.cloudPauseSeconds,
    };
  }, [
    settings.cloudModelId,
    settings.voiceId,
    settings.sentenceGapSeconds,
    settings.cloudPauseSeconds,
  ]);

  // Initialize narrator instance (for browser voices)
  useEffect(() => {
    if (!isSupported) return;

    narratorRef.current = new ArticleNarrator();

    // Subscribe to state changes (only used for browser voices)
    const unsubscribe = narratorRef.current.onStateChange((newState) => {
      if (!usesBufferedPlayer) {
        // Translate narration paragraph index to DOM element index using the mapping
        const mapping = paragraphMapRef.current[newState.currentParagraph];
        const domElementIndex = mapping ? mapping.o : newState.currentParagraph;

        setPlayerState({
          ...newState,
          currentParagraph: domElementIndex,
          currentNarrationParagraph: newState.currentParagraph,
        });
      }
    });

    return () => {
      unsubscribe();
      narratorRef.current?.stop();
      narratorRef.current = null;
    };
  }, [isSupported, usesBufferedPlayer]);

  // Apply user settings when they change
  useEffect(() => {
    piperPlayerRef.current?.setRate(settings.rate);
    cloudPlayerRef.current?.setRate(settings.rate);
    if (!narratorRef.current || usesBufferedPlayer) return;

    narratorRef.current.setRate(settings.rate);
    narratorRef.current.setPitch(settings.pitch);
  }, [settings.rate, settings.pitch, usesBufferedPlayer]);

  // Get the voice from settings when it changes (browser voices only)
  useEffect(() => {
    if (!isSupported || !narratorRef.current || usesBufferedPlayer) return;

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
  }, [isSupported, settings.voiceId, usesBufferedPlayer]);

  // State updates from the Piper and cloud players (same callback shape).
  const bufferedPlayerCallbacks = useMemo(
    (): PlayerCallbacks => ({
      onStatusChange: (status: PlaybackStatus) => {
        setPlayerState((prev) => ({ ...prev, status }));
      },
      onPositionChange: (position: PlaybackPosition, totalParagraphs: number) => {
        // Translate narration paragraph index to DOM element index using the mapping
        const mapping = paragraphMapRef.current[position.paragraph];
        const domElementIndex = mapping ? mapping.o : position.paragraph;

        setPlayerState((prev) => ({
          ...prev,
          currentParagraph: domElementIndex,
          currentNarrationParagraph: position.paragraph,
          totalParagraphs,
        }));
      },
      onError: (error: Error) => {
        console.error("Streaming playback error:", error);
        toast.error("Narration stopped", { description: error.message });
        setPlayerState((prev) => ({ ...prev, status: "idle" }));
      },
      onInterrupted: (error: Error) => {
        // The status change to paused comes separately; play tries again.
        toast.error("Narration paused", { description: error.message });
      },
      onEnd: () => {
        setPlayerState((prev) => ({
          ...prev,
          status: "idle",
          currentParagraph: 0,
          currentNarrationParagraph: 0,
        }));
      },
    }),
    []
  );

  const getOrCreatePiperPlayer = useCallback((): MediaSourcePlayer => {
    if (!piperPlayerRef.current) {
      piperPlayerRef.current = createPiperSpeechPlayer(() => ({
        voice: voiceRef.current.voice,
        sentenceGapSeconds: voiceRef.current.sentenceGapSeconds,
      }));
      piperPlayerRef.current.setCallbacks(bufferedPlayerCallbacks);
    }
    return piperPlayerRef.current;
  }, [bufferedPlayerCallbacks]);

  const getOrCreateCloudPlayer = useCallback((): MediaSourcePlayer => {
    if (!cloudPlayerRef.current) {
      cloudPlayerRef.current = prerecordedVoice
        ? createPrerecordedSpeechPlayer(prerecordedVoice)
        : createCloudSpeechPlayer(() => ({
            model: voiceRef.current.model,
            voice: voiceRef.current.voice,
            pauseSeconds: voiceRef.current.cloudPauseSeconds,
          }));
      cloudPlayerRef.current.setCallbacks(bufferedPlayerCallbacks);
    }
    return cloudPlayerRef.current;
  }, [bufferedPlayerCallbacks, prerecordedVoice]);

  /**
   * Start or resume playback.
   * If narration hasn't been generated yet, generates it first.
   */
  const play = useCallback(async () => {
    if (!isSupported) return;

    // pause/stop, and the article/voice/variant reset (including unmount), bump
    // this token. Every path re-checks it after each await, so narration that
    // finishes generating after the user moved on is neither stored (it may be
    // for a variant no longer on screen) nor played — playback would outlive
    // this entry's controls, and cloud playback is paid.
    const request = playRequestRef.current;
    const isStale = () => playRequestRef.current !== request;

    // Start the audio element within this user gesture, before any async
    // narration generation, so the browser grants it while the gesture's
    // autoplay activation is still valid (issue #410): Piper and cloud voices
    // prime their own player's element, browser voices the media session's
    // silent audio. It's released below if generation fails.
    const player = usePiper ? getOrCreatePiperPlayer() : useCloud ? getOrCreateCloudPlayer() : null;
    // Both primed elements are shared across requests, so each release only
    // takes effect if no newer play() has primed since.
    let playerLease: number | null = null;
    let mediaSessionGeneration: number | null = null;
    if (player) {
      if (player.getStatus() === "idle") playerLease = player.prime();
    } else {
      mediaSessionGeneration = primeMediaSessionAudio();
    }
    const releasePrimedAudio = () => {
      if (player) {
        if (playerLease !== null) player.releasePrime(playerLease);
      } else if (mediaSessionGeneration !== null) {
        releasePrimedMediaSessionAudio(mediaSessionGeneration);
      }
    };

    // Generates narration text (client-side, or on the server for LLM
    // normalization), stores it with its paragraph map, then hands it to `start`.
    const loadNarration = async (start: (narration: string) => Promise<void>) => {
      // Only the latest load owns the generating flag, so an abandoned one
      // finishing late can't flip a newer one's spinner off.
      const load = ++loadRequestRef.current;
      const isLatestLoad = () => loadRequestRef.current === load;
      setIsGenerating(true);

      try {
        let narration: string;
        let paragraphMap: ParagraphMapEntry[];
        let processedHtmlResult: string | null = null;

        if (!settings.useLlmNormalization && content) {
          const clientResult = htmlToClientNarration(content);
          narration = clientResult.narrationText;
          processedHtmlResult = clientResult.processedHtml;
          paragraphMap = clientResult.paragraphMap;
        } else {
          const result = await generateMutation.mutateAsync({
            id,
            useLlmNormalization: settings.useLlmNormalization,
            showFullContent: showFullContent ?? false,
            showOriginal: showOriginal ?? false,
          });
          narration = result.narration;
          paragraphMap = result.paragraphMap;
        }

        if (isStale()) {
          releasePrimedAudio();
          return;
        }

        paragraphMapRef.current = paragraphMap;
        if (narration) {
          setNarrationText(narration);
          setProcessedHtml(processedHtmlResult);
          await start(narration);
        } else {
          // Nothing to narrate — release the primed media-session audio.
          releasePrimedAudio();
        }
      } catch (error) {
        console.error("Failed to generate narration:", error);
        // Release the media-session audio primed within the play() gesture.
        releasePrimedAudio();
      } finally {
        if (isLatestLoad()) setIsGenerating(false);
      }
    };

    if (player) {
      player.setRate(settings.rate);
      const playerStatus = player.getStatus();
      if (playerStatus === "paused") await player.play();
      if (playerStatus !== "idle") return;

      const start = async (narration: string) => {
        player.load(splitNarrationParagraphs(narration));
        // Demo plays aren't cloud voice use.
        if (!hasTrackedPlaybackRef.current && !prerecordedVoice) {
          trackNarrationPlaybackStarted(settings.provider);
          hasTrackedPlaybackRef.current = true;
        }
        await player.play();
      };
      if (narrationText) await start(narrationText);
      else await loadNarration(start);
      return;
    }

    const narrator = narratorRef.current;
    if (!narrator) return;

    if (playerState.status === "paused") {
      narrator.resume();
      return;
    }
    if (playerState.status === "playing") return;

    const startBrowser = () => {
      const voice = settings.voiceId ? findVoiceByUri(settings.voiceId) : null;
      narrator.play(voice ?? undefined, settings.rate, settings.pitch);
      trackNarrationPlaybackStarted(settings.provider);
    };
    if (narrationText && playerState.totalParagraphs > 0) {
      startBrowser();
      return;
    }
    await loadNarration(async (narration) => {
      narrator.loadArticle(narration);
      await waitForVoices();
      if (isStale()) {
        releasePrimedAudio();
        return;
      }
      startBrowser();
    });
  }, [
    isSupported,
    usePiper,
    useCloud,
    playerState.status,
    playerState.totalParagraphs,
    narrationText,
    settings.voiceId,
    settings.rate,
    settings.pitch,
    settings.provider,
    settings.useLlmNormalization,
    generateMutation,
    id,
    content,
    showFullContent,
    showOriginal,
    getOrCreatePiperPlayer,
    getOrCreateCloudPlayer,
    prerecordedVoice,
  ]);

  // The active Piper or cloud player, if either is in use.
  const bufferedPlayer = useCallback(
    () => (usePiper ? piperPlayerRef.current : useCloud ? cloudPlayerRef.current : null),
    [usePiper, useCloud]
  );

  const pause = useCallback(() => {
    if (!isSupported) return;
    cancelPendingPlay(playRequestRef);
    const player = bufferedPlayer();
    if (player) player.pause();
    else if (!usesBufferedPlayer) narratorRef.current?.pause();
  }, [isSupported, bufferedPlayer, usesBufferedPlayer]);

  const skipForward = useCallback(async () => {
    if (!isSupported) return;
    const player = bufferedPlayer();
    if (player) await player.skipForward();
    else if (!usesBufferedPlayer) narratorRef.current?.skipForward();
  }, [isSupported, bufferedPlayer, usesBufferedPlayer]);

  const skipBackward = useCallback(async () => {
    if (!isSupported) return;
    const player = bufferedPlayer();
    if (player) await player.skipBackward();
    else if (!usesBufferedPlayer) narratorRef.current?.skipBackward();
  }, [isSupported, bufferedPlayer, usesBufferedPlayer]);

  const playFromElement = useCallback(
    async (elementIndex: number) => {
      if (!isSupported) return;

      // No map means indices were never translated (see the state callbacks
      // above), so the element index already is the narration index.
      const paragraphIndex =
        paragraphMapRef.current.length === 0
          ? elementIndex
          : narrationParagraphForElement(paragraphMapRef.current, elementIndex);
      if (paragraphIndex === null) return;

      const player = bufferedPlayer();
      if (player) {
        await player.skipTo(paragraphIndex);
        return;
      }

      if (!usesBufferedPlayer) narratorRef.current?.skipTo(paragraphIndex);
    },
    [isSupported, bufferedPlayer, usesBufferedPlayer]
  );

  /**
   * Stop playback and reset to beginning.
   */
  const stop = useCallback(() => {
    if (!isSupported) return;
    cancelPendingPlay(playRequestRef);
    const player = bufferedPlayer();
    if (player) player.stop();
    else if (!usesBufferedPlayer) narratorRef.current?.stop();
  }, [isSupported, bufferedPlayer, usesBufferedPlayer]);

  // Reset narration state when the article, voice, or displayed content variant
  // changes (render-time pattern avoids cascading renders from calling setState
  // inside an effect). The variant is part of the key because narration text and
  // its paragraph map are variant-specific: replaying a cached "cleaned"
  // narration while the DOM now shows "full"/"original" would highlight the
  // wrong elements. Resetting forces the next play to re-narrate what's on screen.
  const narrationResetKey = `${id}:${settings.provider}:${settings.cloudModelId}:${settings.voiceId}:${showFullContent ?? false}:${showOriginal ?? false}`;
  const [prevNarrationResetKey, setPrevNarrationResetKey] = useState(narrationResetKey);
  if (narrationResetKey !== prevNarrationResetKey) {
    setPrevNarrationResetKey(narrationResetKey);
    setProcessedHtml(null);
    setNarrationText(null);
    // A load still in flight is abandoned (the effect cleanup below cancels
    // it), so end its spinner now rather than when the stale request returns.
    setIsGenerating(false);
    setPlayerState(DEFAULT_NARRATION_STATE);
  }

  // Reset per-article refs, and stop/clear playback when the article, voice, or
  // displayed content variant changes (or on unmount).
  useEffect(() => {
    hasTrackedPlaybackRef.current = false;
    return () => {
      // The paragraph map is specific to this article/variant. Cleared first,
      // so the narrator's report below doesn't translate through it.
      paragraphMapRef.current = [];
      // Unload the Web Speech narrator too, not just the media players: toggling
      // the content variant does not remount this hook (EntryContent is keyed only
      // by the entry id), so without this the browser voice keeps reading the old
      // variant. Unloading rather than stopping, so the state it reports holds
      // none of the old variant's paragraphs.
      narratorRef.current?.loadArticle("");
      piperPlayerRef.current?.stop();
      piperPlayerRef.current?.clearCache();
      cancelPendingPlay(playRequestRef);
      cloudPlayerRef.current?.stop();
      cloudPlayerRef.current?.clearCache();
    };
  }, [
    id,
    settings.provider,
    settings.cloudModelId,
    settings.voiceId,
    showFullContent,
    showOriginal,
  ]);

  // Expose OS-level media controls (lock screen, notification, Bluetooth/media
  // keys) while narration is active. Works for every provider by driving the
  // provider-agnostic play/pause/skip callbacks above. A session
  // exists once narration text has been generated for this article.
  const status: NarrationStatus =
    isGenerating && playerState.status === "idle" ? "generating" : playerState.status;
  const state = useMemo(
    (): UseNarrationState => ({ ...playerState, status }),
    [playerState, status]
  );
  const { canSkipBackward, canSkipForward } = getNarrationPhase(state);
  useMediaSession({
    active: isSupported && narrationText !== null,
    title,
    feedTitle,
    artwork,
    status: state.status,
    ownsMediaElement: usesBufferedPlayer,
    canSkipBackward,
    canSkipForward,
    controls: {
      play,
      pause,
      stop,
      previousTrack: skipBackward,
      nextTrack: skipForward,
    },
  });

  return {
    state,
    play,
    pause,
    skipForward,
    skipBackward,
    playFromElement,
    stop,
    isSupported,
    processedHtml,
  };
}
