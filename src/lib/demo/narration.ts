import {
  DEFAULT_CLOUD_SPEECH_PAUSE_SECONDS,
  DEFAULT_CLOUD_VOICES,
  SELFHOSTED_KOKORO,
} from "@/lib/narration/constants";
import type { PrerecordedVoice } from "@/lib/narration/prerecorded-speech";

/**
 * The voice the demo narrates in, from recordings
 * (`@/server/services/demo-narration`): the default cloud voice, on the
 * operator's own speech server, so recording new demo text costs nothing.
 */
export const DEMO_NARRATION_VOICE: PrerecordedVoice = {
  model: SELFHOSTED_KOKORO,
  voice: DEFAULT_CLOUD_VOICES[SELFHOSTED_KOKORO],
  pauseSeconds: DEFAULT_CLOUD_SPEECH_PAUSE_SECONDS,
};
