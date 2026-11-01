/**
 * Enhanced voices: Phonon 31m (Apache-2.0), run in the browser by
 * `./phonon-tts`. Every voice shares one model download; a voice itself is a
 * small embedding fetched the first time it speaks.
 *
 * @module narration/enhanced-voices
 */

const MODEL_REPO =
  "https://huggingface.co/gradium/phonon-31m-en/resolve/8c64b55ec301728e2d1695bfea87a08a267d0c2d";
const VOICES_REPO =
  "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7";

/**
 * The model's files, pinned to a commit so the package's download cache (keyed
 * by URL) never serves a stale file.
 */
export const PHONON_MODEL_FILES = {
  weights: `${MODEL_REPO}/model.q8.gguf`,
  tokenizer: `${MODEL_REPO}/tokenizer.json`,
  config: `${MODEL_REPO}/config.json`,
};

/** What downloading the model costs, for the UI. */
export const PHONON_MODEL_SIZE_BYTES = 64_512_352 + 277_967 + 2_851;

export interface EnhancedVoice {
  /** The voice's id in the `gradium/phonon-voices` catalog. */
  id: string;
  name: string;
  locale: "en-US" | "en-GB";
  gender: "female" | "male";
  /** The catalog's description of the voice. */
  description: string;
}

/** The catalog's English voices, minus its theatrical character voices. */
export const ENHANCED_VOICES: readonly EnhancedVoice[] = [
  {
    id: "NbpkqMVS3CJeq2j8",
    name: "Zoey",
    locale: "en-US",
    gender: "female",
    description:
      "Playful, upbeat and Gen Z energy voice with a standard American accent. Perfect for engaging conversations!",
  },
  {
    id: "NIWIOv5vTi5eRMj8",
    name: "Juniper",
    locale: "en-US",
    gender: "female",
    description:
      "Cheerful presence with real resonance under it, personable when the copy turns intimate and decisive on the final line.",
  },
  {
    id: "vjFyp2BcCyTlUmYb",
    name: "Everly",
    locale: "en-US",
    gender: "female",
    description:
      "Rounded, soft-edged tone with gentle lift at the end of phrases and an easy, relaxed delivery.",
  },
  {
    id: "4SZHfMpw-p46Ywgs",
    name: "Harper",
    locale: "en-US",
    gender: "female",
    description: "Modern, confident and friendly voice with a standard American accent.",
  },
  {
    id: "bXwrkHhURL1VFJdG",
    name: "Hadley",
    locale: "en-US",
    gender: "female",
    description:
      "Settled, even-toned and genuinely kind, with crisp consonants that hold up over a handset.",
  },
  {
    id: "nGzMHMPAWGaJFHOo",
    name: "Delia",
    locale: "en-US",
    gender: "female",
    description:
      "Low, grounded and quick to the point, with a sincerity that keeps an apology honest.",
  },
  {
    id: "LMDIYE0Oa377Qh6Z",
    name: "Easton",
    locale: "en-US",
    gender: "male",
    description:
      "Punchy and close in, with crisp consonant attack that cuts through a music bed and pitch that lifts across each line.",
  },
  {
    id: "40QrMVgAxFiUnP9f",
    name: "Micah",
    locale: "en-US",
    gender: "male",
    description:
      "Buoyant and high in energy, with a playful lift at the ends of phrases and clean attack that survives a loud mix.",
  },
  {
    id: "0zLApsZfVLLNaEGl",
    name: "Trevor",
    locale: "en-US",
    gender: "male",
    description:
      "Buoyant energy over a resonant mid-low core, phrases landing softly and consonants cutting through a handset.",
  },
  {
    id: "_6Aslh2DxfmnRLmP",
    name: "Russell",
    locale: "en-US",
    gender: "male",
    description:
      "A high-energy American adult voice that pushes and encourages with the intensity of someone who genuinely believes in you.",
  },
  {
    id: "qIxlZ7Ei8KvWlyQH",
    name: "Preston",
    locale: "en-US",
    gender: "male",
    description:
      "Trim, focused delivery with clean edges on every consonant and a steady, low-set core that carries through phone bandwidth.",
  },
  {
    id: "d9XCyhjo4JhkHF1d",
    name: "Miles",
    locale: "en-US",
    gender: "male",
    description:
      "Resonant and decisive, with genuine dynamic range, dropping right down for one clause then driving back up.",
  },
  {
    id: "6PWnV0Nq4wu7RVBT",
    name: "Maeve",
    locale: "en-GB",
    gender: "female",
    description:
      "A sparky, attentive British English adult voice that gets to the point with a smile. Ideal for fast, efficient customer support and helpful voice assistants.",
  },
  {
    id: "GgfEkEJtxZR7gnpy",
    name: "Freya",
    locale: "en-GB",
    gender: "female",
    description:
      "A young British voice, glossy and confident with fast, girly chatter and bubbly sparkle, perfect for a friendly receptionist or assistant.",
  },
  {
    id: "uem82D50GRv2Dwma",
    name: "Pippa",
    locale: "en-GB",
    gender: "female",
    description:
      "A confident, upbeat British English adult voice with infectious energy. Perfect for proactive assistants and motivating customer success calls.",
  },
  {
    id: "y9bQqIDnyxwqK01t",
    name: "Elodie-Rose",
    locale: "en-GB",
    gender: "female",
    description:
      "A young British voice with sharp, enthusiastic energy and crisp articulation, sparky and to the point for customer support and care.",
  },
  {
    id: "gDT1nz7Ie36ZhL-C",
    name: "Imogen",
    locale: "en-GB",
    gender: "female",
    description:
      "A bubbly, friendly British English adult voice that puts callers instantly at ease. Great for onboarding assistants and warm concierge interactions.",
  },
  {
    id: "m9MxpY6IUGXtWp76",
    name: "Lottie",
    locale: "en-GB",
    gender: "female",
    description:
      "Sparky and to the point, high forward energy with clean edges on the consonants and the range to drop low for one line then climb back.",
  },
  {
    id: "X6NceqF285Gr04gb",
    name: "Alfie",
    locale: "en-GB",
    gender: "male",
    description:
      "Punchy and forward, with crisp consonant attack and a pitch that lifts across a line, sitting high over a music bed.",
  },
  {
    id: "YyKcxPG7iIgS3jsK",
    name: "Hugh",
    locale: "en-GB",
    gender: "male",
    description:
      "Soft and close, airy in texture, with lively pitch movement and an attentive, sincere delivery.",
  },
  {
    id: "zUCxzrOrugTSis03",
    name: "Edwin",
    locale: "en-GB",
    gender: "male",
    description:
      "Efficient and firm, sincere in attention, with tidy articulation that holds up at phone bandwidth.",
  },
  {
    id: "JOW0vchyswkQUMDS",
    name: "Spencer",
    locale: "en-GB",
    gender: "male",
    description:
      "Light and airy, sitting a touch higher, with crisp consonants and a slow, patient delivery.",
  },
  {
    id: "dME3IWyZBvmh1n1q",
    name: "Toby",
    locale: "en-GB",
    gender: "male",
    description:
      "A sparky, attentive British English adult voice that gets to the point with a smile. Ideal for fast, efficient customer support and helpful voice assistants.",
  },
  {
    id: "Zn7g6NxLqXlJb7Qi",
    name: "Teddy",
    locale: "en-GB",
    gender: "male",
    description:
      "Sparky and close in, quick off the mark, with firm consonants and the range to drop right down for a clause then come back up.",
  },
  {
    id: "gfP44RlHwr2kEwk7",
    name: "Bryony",
    locale: "en-GB",
    gender: "female",
    description:
      "Full, rich mid-range tones, softly relaxed and spoken close to the mic, moving briskly with light pitch play.",
  },
];

export function enhancedVoiceUrl(voiceId: string): string {
  return `${VOICES_REPO}/voices/${voiceId}.safetensors`;
}

/** Even-toned, which suits reading articles better than the catalog's first, Zoey. */
const DEFAULT_VOICE_ID = "bXwrkHhURL1VFJdG";

/** The voice `voiceId` names, or the default for null or a voice we don't offer. */
export function resolveEnhancedVoice(voiceId: string | null): EnhancedVoice {
  return (
    ENHANCED_VOICES.find((v) => v.id === voiceId) ??
    ENHANCED_VOICES.find((v) => v.id === DEFAULT_VOICE_ID)!
  );
}

export function isEnhancedVoice(voiceId: string): boolean {
  return ENHANCED_VOICES.some((v) => v.id === voiceId);
}
