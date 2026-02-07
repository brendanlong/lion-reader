import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "text-to-speech",
  subscriptionId: "reading-experience",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/15",
  title: "Text-to-Speech Narration",
  author: null,
  summary:
    "Listen to articles read aloud with AI-enhanced text preprocessing and paragraph highlighting.",
  publishedAt: new Date("2025-12-27T18:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader converts articles to audio using a two-stage process: an <strong>AI preprocessor</strong> (Llama 3.1) transforms HTML into narration-friendly text by expanding abbreviations and formatting complex elements, then either Web Speech API or local <strong>Piper TTS</strong> synthesizes speech. Features include synchronized paragraph highlighting, playback controls, and offline capability.</p>`,
  contentHtml: `
    <h2>Text-to-Speech Narration</h2>

    <p>Sometimes you want to listen instead of read &mdash; while cooking, commuting, or just giving your eyes a rest. Lion Reader&rsquo;s narration feature transforms articles into natural-sounding audio using a two-stage pipeline that combines AI preprocessing with on-device speech synthesis.</p>

    <h3>Stage 1: AI Text Preprocessing</h3>

    <p>Raw article HTML isn&rsquo;t ready for text-to-speech. Abbreviations like &ldquo;Dr.&rdquo; get mispronounced, URLs sound terrible when read aloud, and technical notation confuses speech engines. To solve this, Lion Reader first sends article content through an LLM (Llama 3.1 via <a href="https://groq.com/" target="_blank" rel="noopener noreferrer">Groq</a>) that transforms the text for natural narration.</p>

    <p>The AI expands abbreviations (&ldquo;Dr.&rdquo; becomes &ldquo;Doctor&rdquo;), converts URLs to readable phrases, formats lists and tables as natural language, and handles code blocks with clear verbal markers. Crucially, it maintains paragraph-level mapping so the app can synchronize highlighting as the audio plays. This preprocessing is cached by content hash, so the same article is only processed once &mdash; even if multiple users narrate it.</p>

    <h3>Stage 2: Audio Synthesis</h3>

    <p>After preprocessing, you can choose between two synthesis options. The Web Speech API uses your browser&rsquo;s built-in voices for instant, zero-cost narration. Or enable <a href="https://github.com/rhasspy/piper" target="_blank" rel="noopener noreferrer">Piper TTS</a> for higher-quality neural voice synthesis powered by ONNX Runtime WebAssembly running locally in your browser &mdash; no server required, no per-character fees.</p>

    <h3>Reading Along</h3>

    <p>As narration plays, Lion Reader highlights each paragraph in sync with the audio and automatically scrolls to keep the current paragraph visible. You can control playback speed, skip forward or backward by paragraph, and use media session integration to control narration from your lock screen or notification shade. If the LLM service is unavailable, the system gracefully falls back to plain text narration so you can always listen to your articles.</p>
  `,
};

export default article;
