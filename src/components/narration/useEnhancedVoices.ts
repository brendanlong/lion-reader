/**
 * useEnhancedVoices Hook
 *
 * The enhanced voice model's download state (downloading, removing it) and
 * voice previews.
 *
 * @module components/narration/useEnhancedVoices
 */

"use client";

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { PREVIEW_TEXT } from "@/lib/narration/constants";
import { getVoiceErrorInfo } from "@/lib/narration/errors";
import {
  downloadPhononModel,
  getPhononModelState,
  loadPhonon,
  removePhononModel,
  subscribePhononModelState,
} from "@/lib/narration/phonon-tts";
import { PreviewAudio } from "@/lib/narration/preview-audio";
import {
  classifyDownloadError,
  trackEnhancedVoiceModelDownloadCompleted,
  trackEnhancedVoiceModelDownloadFailed,
} from "@/lib/telemetry";

export type ModelStatus = "checking" | "not-downloaded" | "downloading" | "downloaded";

export interface UseEnhancedVoicesReturn {
  modelStatus: ModelStatus;
  /** Fraction of the model downloaded, while `downloading`. */
  progress: number;
  downloadModel: () => Promise<void>;
  removeModel: () => Promise<void>;
  previewVoice: (voiceId: string) => Promise<void>;
  stopPreview: () => void;
  previewingVoiceId: string | null;
}

function toastError(title: string, error: unknown): void {
  const { message, suggestion } = getVoiceErrorInfo(error);
  toast.error(title, { description: suggestion ? `${message} ${suggestion}` : message });
}

export function useEnhancedVoices(): UseEnhancedVoicesReturn {
  const stored = useSyncExternalStore(
    subscribePhononModelState,
    getPhononModelState,
    () => "checking" as const
  );
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const modelStatus: ModelStatus = isDownloading
    ? "downloading"
    : stored === "missing"
      ? "not-downloaded"
      : stored;
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const previewRef = useRef<PreviewAudio | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      previewRef.current?.stop();
      previewRef.current = null;
      previewAbortRef.current?.abort();
    };
  }, []);

  const downloadModel = useCallback(async () => {
    setIsDownloading(true);
    setProgress(0);
    try {
      await downloadPhononModel((fraction) => {
        if (isMountedRef.current) setProgress(fraction);
      });
      trackEnhancedVoiceModelDownloadCompleted();
    } catch (err) {
      trackEnhancedVoiceModelDownloadFailed(classifyDownloadError(err));
      toastError("Failed to download the voice model", err);
    } finally {
      if (isMountedRef.current) setIsDownloading(false);
    }
  }, []);

  const stopPreview = useCallback(() => {
    previewRef.current?.stop();
    previewRef.current = null;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    if (isMountedRef.current) setPreviewingVoiceId(null);
  }, []);

  const removeModel = useCallback(async () => {
    stopPreview();
    try {
      await removePhononModel();
    } catch (err) {
      toastError("Failed to remove the voice model", err);
    }
  }, [stopPreview]);

  const previewVoice = useCallback(
    async (voiceId: string) => {
      previewRef.current?.stop();
      previewAbortRef.current?.abort();
      const preview = new PreviewAudio();
      const abort = new AbortController();
      previewRef.current = preview;
      previewAbortRef.current = abort;
      setPreviewingVoiceId(voiceId);

      const fail = (err: unknown) => {
        stopPreview();
        toastError("Failed to preview voice", err);
      };
      try {
        const tts = await loadPhonon();
        const clip = await tts.synthWav(PREVIEW_TEXT, { voice: voiceId, signal: abort.signal });
        // Superseded by another preview, a stop, or unmount.
        if (previewRef.current !== preview) return;
        preview.play(clip, 1.0, (error) => (error ? fail(error) : stopPreview()));
      } catch (err) {
        if (previewRef.current === preview) fail(err);
      }
    },
    [stopPreview]
  );

  return {
    modelStatus,
    progress,
    downloadModel,
    removeModel,
    previewVoice,
    stopPreview,
    previewingVoiceId,
  };
}
