/**
 * Model and voice selection for cloud voices (server-synthesized speech).
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/settings/ModelPicker";
import { trpc } from "@/lib/trpc/client";
import { AI_PROVIDER_DISPLAY_NAMES, normalizeModelRef, type AiProvider } from "@/lib/ai/model-ref";
import { base64ToBytes } from "@/lib/narration/audio-encoding";
import { PreviewAudio } from "@/lib/narration/preview-audio";
import { PREVIEW_TEXT, SUGGESTED_CLOUD_VOICE_MODELS } from "@/lib/narration/constants";
import type { NarrationSettings, SetNarrationSettings } from "@/lib/narration/settings";

type VoiceModel = {
  id: string;
  displayName: string;
  provider: AiProvider;
  voices: string[];
  voiceNames: Record<string, string>;
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
  const pickedModelId = settings.cloudModelId ? normalizeModelRef(settings.cloudModelId) : null;
  // A picked model that isn't listed (e.g. its provider's key was removed);
  // the voices shown are the default model's, which the server falls back to
  // when the provider has no key.
  const pickedModel = models.find((candidate) => candidate.id === pickedModelId);
  const isPickedUnavailable = pickedModelId !== null && !pickedModel && !isLoading;
  const model = pickedModel ?? models.find((candidate) => candidate.id === defaultModelId);
  const modelId = model?.id ?? pickedModelId ?? defaultModelId;
  const voice =
    settings.voiceId && model?.voices.includes(settings.voiceId)
      ? settings.voiceId
      : model?.defaultVoice;

  const synthesize = trpc.narration.synthesize.useMutation();
  const previewRef = useRef<PreviewAudio | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const stopPreview = useCallback(() => {
    previewRef.current?.stop();
    previewRef.current = null;
    setIsPreviewing(false);
  }, []);

  useEffect(() => stopPreview, [stopPreview]);

  const handlePreview = () => {
    stopPreview();
    const preview = new PreviewAudio();
    previewRef.current = preview;
    synthesize.mutate(
      { model: modelId, voice: voice ?? null, text: PREVIEW_TEXT },
      {
        onSuccess: (result) => {
          // Superseded by another preview, a stop, or a voice/model change.
          if (previewRef.current !== preview) return;
          const clip = new Blob([base64ToBytes(result.audio)], { type: result.mimeType });
          setIsPreviewing(true);
          preview.play(clip, settings.rate, (error) => {
            stopPreview();
            if (error) toast.error("Voice preview failed");
          });
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
          value={pickedModelId}
          defaultModelId={defaultModelId}
          models={models}
          suggestedModelIds={SUGGESTED_CLOUD_VOICE_MODELS}
          isLoading={isLoading}
          onChange={(value) => {
            stopPreview();
            // Voice names are per model.
            const keepVoice = (value ?? defaultModelId) === modelId;
            setSettings((prev) => ({
              ...prev,
              cloudModelId: value,
              voiceId: keepVoice ? prev.voiceId : null,
            }));
          }}
        />
        {isPickedUnavailable && (
          <p className="ui-text-xs text-muted mt-1.5">
            Your chosen model isn&apos;t available. Pick another, or Default.
          </p>
        )}
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
              model.voices.map((id) => (
                <option key={id} value={id}>
                  {model.voiceNames[id] ?? id}
                  {id === model.defaultVoice ? " (default)" : ""}
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
        Cloud voices are generated by{" "}
        {model ? AI_PROVIDER_DISPLAY_NAMES[model.provider] : "a cloud provider"}, so the narration
        text is sent there and billed per character. They keep playing with the screen locked or the
        app in the background.
      </p>
    </div>
  );
}
