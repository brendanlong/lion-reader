import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "text-to-speech",
  subscriptionId: "reading-experience",
  type: "web",
  url: null,
  title: "Text-to-Speech Narration",
  author: null,
  summary:
    "Listen to articles read aloud with AI-enhanced text preprocessing and paragraph highlighting.",
  publishedAt: new Date("2025-12-27T18:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader converts articles into natural-sounding audio through a two-stage process:</p>
<p><strong>Stage 1: AI Text Preprocessing</strong></p>
<ul>
<li>Article content is processed by an LLM (Llama 3.1 via Groq) to optimize for speech</li>
<li>Expands abbreviations, converts URLs to readable phrases, and formats lists/tables naturally</li>
<li>Maintains paragraph-level mapping for synchronized highlighting</li>
<li>Results are cached by content hash to avoid reprocessing</li>
</ul>
<p><strong>Stage 2: Audio Synthesis</strong></p>
<ul>
<li><strong>Web Speech API</strong>: Instant narration using browser&#39;s built-in voices (free)</li>
<li><strong>Piper TTS</strong>: Higher-quality neural voices running locally via WebAssembly (no server costs)</li>
</ul>
<p><strong>Features</strong></p>
<ul>
<li>Synchronized paragraph highlighting and auto-scrolling</li>
<li>Playback speed control and paragraph-level navigation</li>
<li>Media session integration for lock screen controls</li>
<li>Graceful fallback to plain text if AI service is unavailable</li>
</ul>`,
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
