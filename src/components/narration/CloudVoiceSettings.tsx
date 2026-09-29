/**
 * Model and voice selection for cloud voices (server-synthesized speech).
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/settings/ModelPicker";
import { trpc } from "@/lib/trpc/client";
import { normalizeModelRef } from "@/lib/ai/model-ref";
import { base64ToBytes } from "@/lib/narration/audio-encoding";
import { createSilentAudioDataUri } from "@/lib/narration/silent-audio";
import { PREVIEW_TEXT, SUGGESTED_CLOUD_VOICE_MODELS } from "@/lib/narration/constants";
import type { NarrationSettings, SetNarrationSettings } from "@/lib/narration/settings";

type VoiceModel = {
  id: string;
  displayName: string;
  provider: "openrouter";
  voices: string[];
  defaultVoice: string;
  pricePerMillionCharacters?: number;
};

export function CloudVoiceSettings({
  settings,
  setSettings,
  models,
  defaultModelId,
  isLoading,
}: {
  settings: NarrationSettings;
  setSettings: SetNarrationSettings;
  models: VoiceModel[];
  defaultModelId: string;
  isLoading: boolean;
}) {
  const modelId = settings.cloudModelId ? normalizeModelRef(settings.cloudModelId) : defaultModelId;
  const model = models.find((candidate) => candidate.id === modelId);
  const voice =
    settings.voiceId && model?.voices.includes(settings.voiceId)
      ? settings.voiceId
      : model?.defaultVoice;

  const synthesize = trpc.narration.synthesize.useMutation();
  const previewRef = useRef<{ audio: HTMLAudioElement; url: string | null } | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const stopPreview = useCallback(() => {
    const preview = previewRef.current;
    if (preview) {
      preview.audio.pause();
      if (preview.url) URL.revokeObjectURL(preview.url);
      previewRef.current = null;
    }
    setIsPreviewing(false);
  }, []);

  useEffect(() => stopPreview, [stopPreview]);

  const handlePreview = () => {
    stopPreview();
    // Start the element inside the tap (iOS only lets a gesture start
    // playback), then swap in the clip when it arrives.
    const audio = new Audio(createSilentAudioDataUri());
    audio.loop = true;
    audio.play().catch(() => {});
    const preview: { audio: HTMLAudioElement; url: string | null } = { audio, url: null };
    previewRef.current = preview;
    synthesize.mutate(
      { model: modelId, voice: voice ?? null, text: PREVIEW_TEXT },
      {
        onSuccess: (result) => {
          // Superseded by another preview, a stop, or a voice/model change.
          if (previewRef.current !== preview) return;
          preview.url = URL.createObjectURL(
            new Blob([base64ToBytes(result.audio)], { type: result.mimeType })
          );
          audio.loop = false;
          audio.src = preview.url;
          audio.playbackRate = settings.rate;
          audio.onended = stopPreview;
          setIsPreviewing(true);
          audio.play().catch(stopPreview);
        },
        onError: (error) => {
          if (previewRef.current === preview) stopPreview();
          toast.error("Voice preview failed", { description: error.message });
        },
      }
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <label
          htmlFor="cloud-voice-model"
          className="ui-text-sm text-body mb-1.5 block font-medium"
        >
          Model
        </label>
        <ModelPicker
          id="cloud-voice-model"
          value={modelId}
          defaultModelId={defaultModelId}
          models={models}
          suggestedModelIds={SUGGESTED_CLOUD_VOICE_MODELS}
          isLoading={isLoading}
          onChange={(value) => {
            stopPreview();
            // Voice names are per model.
            setSettings((prev) => ({ ...prev, cloudModelId: value, voiceId: null }));
          }}
        />
      </div>

      <div>
        <label htmlFor="cloud-voice" className="ui-text-sm text-body mb-1.5 block font-medium">
          Voice
        </label>
        <div className="flex gap-3">
          <select
            id="cloud-voice"
            value={voice ?? ""}
            onChange={(e) => {
              stopPreview();
              setSettings((prev) => ({ ...prev, voiceId: e.target.value }));
            }}
            disabled={!model}
            className="ui-text-sm bg-surface text-body border-edge-input block flex-1 rounded-md border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {model ? (
              model.voices.map((name) => (
                <option key={name} value={name}>
                  {name}
                  {name === model.defaultVoice ? " (default)" : ""}
                </option>
              ))
            ) : (
              <option value="">{isLoading ? "Loading voices..." : "Model unavailable"}</option>
            )}
          </select>
          <Button
            type="button"
            variant="secondary"
            onClick={isPreviewing ? stopPreview : handlePreview}
            loading={synthesize.isPending}
            disabled={!model}
          >
            {isPreviewing ? "Stop" : "Preview"}
          </Button>
        </div>
      </div>

      <p className="ui-text-xs text-muted">
        Cloud voices are generated on OpenRouter, so the narration text is sent there and billed per
        character. They keep playing with the screen locked or the app in the background.
      </p>
    </div>
  );
}
