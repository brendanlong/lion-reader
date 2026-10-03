import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "text-to-speech",
  subscriptionId: "reading-experience",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/15",
  title: "Listen to Any Article",
  author: null,
  summary:
    "Press Listen and Lion Reader reads any article aloud in a natural voice, highlighting along as it goes, and can keep playing with your screen locked.",
  publishedAt: new Date("2025-12-27T18:00:00Z"),
  starred: true,
  summaryHtml: `<p>Press <strong>Listen</strong> on any article and Lion Reader reads it aloud in a natural voice, highlighting each paragraph as it plays, with pause, skip, and speed controls from your lock screen or media keys. Choose cloud voices or offline on-device voices, and turn on AI text processing to adjust wording.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Sometimes you want to listen instead of read &mdash; while cooking, commuting, or just giving your eyes a rest. Press <strong>Listen</strong> at the top of any article and Lion Reader reads it aloud in a natural-sounding voice, highlighting each paragraph as it goes. Try it on this one.</p>

    <p>Pause and skip from your lock screen, your headphones, or your keyboard&rsquo;s media keys, and with the right voice it keeps playing with your screen locked, so you can put your phone in your pocket and keep listening.</p>

    <h3>Follow Along, or Don&rsquo;t</h3>

    <p>The current paragraph stays highlighted and in view as narration plays. Tap any paragraph to jump there, skip ahead or back a paragraph at a time, and speed it up or slow it down to suit you.</p>

    <h3>Choose Your Voice</h3>

    <ul>
      <li><strong>Cloud Voices</strong> &mdash; the most natural-sounding option, and what this demo uses. Pick them in Settings; no extra accounts needed. Narration starts quickly and keeps playing with your screen locked. If you pay for your own account with a supported voice provider, connect it in Settings for even more voices.</li>
      <li><strong>Enhanced Voices</strong> &mdash; for when you&rsquo;d rather nothing leave your device. Download one once and it works offline, even with your screen locked.</li>
      <li><strong>Browser Voices</strong> &mdash; the voices your browser already has, with no setup at all.</li>
    </ul>

    <h3>Smoother Listening</h3>

    <p>Some writing doesn&rsquo;t sound right read aloud word for word. Turn on <strong>AI text processing</strong> and Lion Reader first rewrites the article for listening &mdash; &ldquo;Dr. Smith&rdquo; becomes &ldquo;Doctor Smith,&rdquo; &ldquo;5 ms&rdquo; becomes &ldquo;5 milliseconds&rdquo; &mdash; without summarizing it or changing its meaning. It&rsquo;s off by default.</p>

    <details>
      <summary>What gets sent where</summary>
      <p>With Cloud Voices, only the text being read is sent to the voice provider, a passage at a time. With Enhanced Voices, nothing leaves your device. Browser Voices marked &ldquo;online&rdquo; are run by your browser&rsquo;s maker. With any voice, turning on AI text processing also sends the article to an AI model first.</p>
    </details>
  `,
};

export default article;
