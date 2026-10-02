/**
 * Model and voice selection for cloud voices (server-synthesized speech).
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/settings/ModelPicker";
import { normalizeModelRef } from "@/lib/ai/model-ref";
import { aiProviderName, type AiProvider } from "@/lib/ai/providers";
import { createCloudSpeechPlayer } from "@/lib/narration/cloud-speech";
import type { MediaSourcePlayer } from "@/lib/narration/media-source-player";
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

  const previewRef = useRef<MediaSourcePlayer | null>(null);
  const [preview, setPreview] = useState<"idle" | "loading" | "playing">("idle");

  const stopPreview = useCallback(() => {
    previewRef.current?.stop();
    previewRef.current = null;
    setPreview("idle");
  }, []);

  useEffect(() => stopPreview, [stopPreview]);

  // Plays the way narration does, so what you hear is what narration sounds like.
  const handlePreview = () => {
    stopPreview();
    const player = createCloudSpeechPlayer(() => ({ model: modelId, voice: voice ?? null }));
    previewRef.current = player;
    // Callbacks only count while this is still the preview playing; a stop,
    // a newer preview, or a voice/model change supersedes it.
    const isCurrent = () => previewRef.current === player;
    player.setCallbacks({
      onStatusChange: (status) => {
        if (isCurrent() && status === "playing") setPreview("playing");
      },
      onEnd: () => {
        if (isCurrent()) stopPreview();
      },
      onError: (error) => {
        if (!isCurrent()) return;
        stopPreview();
        toast.error("Voice preview failed", { description: error.message });
      },
    });
    player.setRate(settings.rate);
    // Inside the tap: only a gesture may start playback, and the audio arrives later.
    player.prime();
    player.load([PREVIEW_TEXT]);
    setPreview("loading");
    void player.play();
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
            onClick={preview === "idle" ? handlePreview : stopPreview}
            loading={preview === "loading"}
            disabled={!model}
          >
            {preview === "playing" ? "Stop" : "Preview"}
          </Button>
        </div>
      </div>

      <p className="ui-text-xs text-muted">
        Cloud voices are generated by {model ? aiProviderName(model.provider) : "a cloud provider"},
        so the narration text is sent there and billed per character. They keep playing with the
        screen locked or the app in the background.
      </p>
    </div>
  );
}
