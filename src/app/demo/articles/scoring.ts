import { type DemoArticle } from "./types";

// TODO Publish this once the feature is actually finished: https://github.com/brendanlong/lion-reader/issues/323
const article: DemoArticle = {
  id: "scoring",
  subscriptionId: "organization",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/450",
  title: "Entry Scoring & Recommendations",
  author: null,
  summary:
    "Rate articles and get personalized score predictions powered by server-side machine learning.",
  publishedAt: new Date("2026-01-20T12:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader learns your preferences through explicit voting and implicit signals like starring or marking entries read. After 20+ ratings, it trains a <strong>server-side ML model</strong> using TF-IDF and Ridge Regression to predict scores for new content, automatically scoring new entries as feeds are fetched.</p>`,
  contentHtml: `
    <h2>Rate Your Reading</h2>

    <p>Lion Reader tracks your preferences through both explicit voting and implicit behavior. Explicit voting uses a 5-point scale from &minus;2 to +2 with upvote/downvote controls. Rate articles directly to build your preference profile.</p>

    <p>Your implicit behavior also contributes to scoring. Starring an entry signals strong interest (+2), marking an entry as unread to come back to it later shows moderate interest (+1), and marking an entry as read from the list without opening it indicates low interest (&minus;1). Over time, these signals combine to create a detailed picture of what you value.</p>

    <h3>Server-Side Machine Learning</h3>

    <p>Once you&rsquo;ve rated at least 20 entries, Lion Reader trains a machine learning model to predict scores for new content. The model uses TF-IDF text vectorization combined with Ridge Regression, with titles weighted 2x during feature extraction. Per-feed features capture your source-level preferences, so the model learns not just what topics you like, but which publications you trust.</p>

    <p>The model is cross-validated using Mean Absolute Error (MAE) and Pearson correlation metrics to ensure prediction quality. Predictions include confidence scores, helping you understand when recommendations are strong versus tentative. New entries are automatically scored after feed fetches, helping you prioritize the content you&rsquo;re most likely to enjoy.</p>

    <p>Scoring features:</p>
    <ul>
      <li><strong>Explicit voting</strong> &mdash; &minus;2 to +2 scale with upvote/downvote controls</li>
      <li><strong>Implicit signals</strong> &mdash; Starring (+2), marking unread (+1), quick-mark-read (&minus;1)</li>
      <li><strong>Server-side ML</strong> &mdash; TF-IDF + Ridge Regression model</li>
      <li><strong>Per-feed features</strong> &mdash; Learns source-level preferences</li>
      <li><strong>Confidence scores</strong> &mdash; Know how strong each prediction is</li>
      <li><strong>Automatic scoring</strong> &mdash; New entries scored after feed fetches</li>
    </ul>
  `,
};

export default article;
