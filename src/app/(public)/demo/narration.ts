import {
  DEEPINFRA_KOKORO,
  DEFAULT_CLOUD_SPEECH_PAUSE_SECONDS,
  DEFAULT_CLOUD_VOICES,
} from "@/lib/narration/constants";
import type { PrerecordedVoice } from "@/lib/narration/prerecorded-speech";

/**
 * The voice the demo narrates in, from recordings
 * (`@/server/services/demo-narration`): the app's default cloud voice.
 */
export const DEMO_NARRATION_VOICE: PrerecordedVoice = {
  model: DEEPINFRA_KOKORO,
  voice: DEFAULT_CLOUD_VOICES[DEEPINFRA_KOKORO],
  pauseSeconds: DEFAULT_CLOUD_SPEECH_PAUSE_SECONDS,
};
