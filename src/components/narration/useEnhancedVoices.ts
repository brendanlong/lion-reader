/**
 * useEnhancedVoices Hook
 *
 * Manages enhanced voice state including download status,
 * downloading, and deletion of Piper TTS voices.
 *
 * @module components/narration/useEnhancedVoices
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ENHANCED_VOICES, type EnhancedVoice } from "@/lib/narration/enhanced-voices";
import { getPiperTTSProvider } from "@/lib/narration/piper-tts-provider";

/**
 * Download status for a voice.
 */
export type VoiceDownloadStatus = "not-downloaded" | "downloading" | "downloaded";

/**
 * State for a single enhanced voice.
 */
export interface EnhancedVoiceState {
  voice: EnhancedVoice;
  status: VoiceDownloadStatus;
  progress: number;
}

/**
 * Return type for the useEnhancedVoices hook.
 */
export interface UseEnhancedVoicesReturn {
  /**
   * List of voices with their current state.
   */
  voices: EnhancedVoiceState[];

  /**
   * Whether the voice list is loading.
   */
  isLoading: boolean;

  /**
   * Download a voice by ID.
   */
  downloadVoice: (voiceId: string) => Promise<void>;

  /**
   * Remove a downloaded voice by ID.
   */
  removeVoice: (voiceId: string) => Promise<void>;

  /**
   * Preview a voice by speaking sample text.
   */
  previewVoice: (voiceId: string) => Promise<void>;

  /**
   * Stop the current preview.
   */
  stopPreview: () => void;

  /**
   * Whether a preview is currently playing.
   */
  isPreviewing: boolean;

  /**
   * The ID of the voice currently being previewed.
   */
  previewingVoiceId: string | null;

  /**
   * Refresh the voice status from storage.
   */
  refreshStatus: () => Promise<void>;

  /**
   * Error message if an operation failed.
   */
  error: string | null;

  /**
   * Clear the current error.
   */
  clearError: () => void;
}

/**
 * Sample text for voice preview.
 */
const PREVIEW_TEXT = "This is a preview of how articles will sound with this voice.";

/**
 * Hook for managing enhanced voices.
 *
 * Provides state and operations for downloading, removing, and previewing
 * Piper TTS voices.
 *
 * @returns Object with voice states and operation handlers.
 *
 * @example
 * ```tsx
 * function VoiceList() {
 *   const { voices, downloadVoice, removeVoice, previewVoice, isPreviewing } = useEnhancedVoices();
 *
 *   return (
 *     <ul>
 *       {voices.map(({ voice, status }) => (
 *         <li key={voice.id}>
 *           {voice.displayName}
 *           {status === 'downloaded' && (
 *             <button onClick={() => previewVoice(voice.id)}>Preview</button>
 *           )}
 *         </li>
 *       ))}
 *     </ul>
 *   );
 * }
 * ```
 */
export function useEnhancedVoices(): UseEnhancedVoicesReturn {
  const [voiceStates, setVoiceStates] = useState<
    Map<string, { status: VoiceDownloadStatus; progress: number }>
  >(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track if component is mounted to avoid state updates after unmount
  const isMountedRef = useRef(true);

  // Initialize voice states
  useEffect(() => {
    isMountedRef.current = true;

    const loadVoiceStatus = async () => {
      try {
        const provider = getPiperTTSProvider();
        const storedVoices = await provider.getStoredVoiceIds();
        const storedSet = new Set(storedVoices);

        if (!isMountedRef.current) return;

        const initialStates = new Map<string, { status: VoiceDownloadStatus; progress: number }>();
        for (const voice of ENHANCED_VOICES) {
          initialStates.set(voice.id, {
            status: storedSet.has(voice.id) ? "downloaded" : "not-downloaded",
            progress: 0,
          });
        }
        setVoiceStates(initialStates);
      } catch {
        // If storage check fails, assume not downloaded
        const initialStates = new Map<string, { status: VoiceDownloadStatus; progress: number }>();
        for (const voice of ENHANCED_VOICES) {
          initialStates.set(voice.id, { status: "not-downloaded", progress: 0 });
        }
        if (isMountedRef.current) {
          setVoiceStates(initialStates);
        }
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
        }
      }
    };

    void loadVoiceStatus();

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Refresh status from storage
  const refreshStatus = useCallback(async () => {
    try {
      const provider = getPiperTTSProvider();
      const storedVoices = await provider.getStoredVoiceIds();
      const storedSet = new Set(storedVoices);

      if (!isMountedRef.current) return;

      setVoiceStates((prev) => {
        const newStates = new Map(prev);
        for (const voice of ENHANCED_VOICES) {
          const current = newStates.get(voice.id);
          // Only update if not currently downloading
          if (current?.status !== "downloading") {
            newStates.set(voice.id, {
              status: storedSet.has(voice.id) ? "downloaded" : "not-downloaded",
              progress: 0,
            });
          }
        }
        return newStates;
      });
    } catch {
      // Silently fail - keep existing state
    }
  }, []);

  // Download a voice
  const downloadVoice = useCallback(async (voiceId: string) => {
    setError(null);

    // Update status to downloading
    setVoiceStates((prev) => {
      const newStates = new Map(prev);
      newStates.set(voiceId, { status: "downloading", progress: 0 });
      return newStates;
    });

    try {
      const provider = getPiperTTSProvider();
      await provider.downloadVoice(voiceId, (progress) => {
        if (!isMountedRef.current) return;
        setVoiceStates((prev) => {
          const newStates = new Map(prev);
          newStates.set(voiceId, { status: "downloading", progress });
          return newStates;
        });
      });

      if (!isMountedRef.current) return;

      // Update status to downloaded
      setVoiceStates((prev) => {
        const newStates = new Map(prev);
        newStates.set(voiceId, { status: "downloaded", progress: 1 });
        return newStates;
      });
    } catch (err) {
      if (!isMountedRef.current) return;

      // Reset status on error
      setVoiceStates((prev) => {
        const newStates = new Map(prev);
        newStates.set(voiceId, { status: "not-downloaded", progress: 0 });
        return newStates;
      });

      const message = err instanceof Error ? err.message : "Failed to download voice";
      setError(message);
    }
  }, []);

  // Remove a downloaded voice
  const removeVoice = useCallback(async (voiceId: string) => {
    setError(null);

    try {
      const provider = getPiperTTSProvider();
      await provider.removeVoice(voiceId);

      if (!isMountedRef.current) return;

      // Update status to not downloaded
      setVoiceStates((prev) => {
        const newStates = new Map(prev);
        newStates.set(voiceId, { status: "not-downloaded", progress: 0 });
        return newStates;
      });
    } catch (err) {
      if (!isMountedRef.current) return;

      const message = err instanceof Error ? err.message : "Failed to remove voice";
      setError(message);
    }
  }, []);

  // Preview a voice
  const previewVoice = useCallback(async (voiceId: string) => {
    setError(null);
    setIsPreviewing(true);
    setPreviewingVoiceId(voiceId);

    try {
      const provider = getPiperTTSProvider();
      await provider.speak(PREVIEW_TEXT, {
        voiceId,
        rate: 1.0,
        onEnd: () => {
          if (!isMountedRef.current) return;
          setIsPreviewing(false);
          setPreviewingVoiceId(null);
        },
        onError: (err) => {
          if (!isMountedRef.current) return;
          setIsPreviewing(false);
          setPreviewingVoiceId(null);
          setError(err.message);
        },
      });
    } catch (err) {
      if (!isMountedRef.current) return;
      setIsPreviewing(false);
      setPreviewingVoiceId(null);
      const message = err instanceof Error ? err.message : "Failed to preview voice";
      setError(message);
    }
  }, []);

  // Stop current preview
  const stopPreview = useCallback(() => {
    const provider = getPiperTTSProvider();
    provider.stop();
    setIsPreviewing(false);
    setPreviewingVoiceId(null);
  }, []);

  // Clear error
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Build the voices array with current state
  const voices: EnhancedVoiceState[] = ENHANCED_VOICES.map((voice) => {
    const state = voiceStates.get(voice.id) ?? { status: "not-downloaded" as const, progress: 0 };
    return {
      voice,
      status: state.status,
      progress: state.progress,
    };
  });

  return {
    voices,
    isLoading,
    downloadVoice,
    removeVoice,
    previewVoice,
    stopPreview,
    isPreviewing,
    previewingVoiceId,
    refreshStatus,
    error,
    clearError,
  };
}
