import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "scoring",
  subscriptionId: "organization",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/615",
  title: "Algorithmic Feed & Entry Scoring",
  author: null,
  summary:
    "Rate articles and get a personalized Best feed powered by server-side machine learning.",
  publishedAt: new Date("2026-02-21T02:49:57Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader uses machine learning to create a personalized <strong>Best feed</strong> by predicting which articles you&rsquo;ll enjoy. It learns from your explicit ratings (&minus;2 to +2) and implicit behavior (starring, saving, quick-marking). The TF-IDF model includes per-feed preferences and confidence-based scoring adjustments.</p>`,
  contentHtml: `
    <h2>The Best Feed</h2>

    <p>Once you start rating articles, a <strong>Best</strong> link appears in the sidebar. This algorithmic feed shows all your unread entries sorted by predicted score, surfacing the content you&rsquo;re most likely to enjoy. It updates automatically as new articles arrive and get scored.</p>

    <h2>Rate Your Reading</h2>

    <p>Lion Reader tracks your preferences through both explicit voting and implicit behavior. Voting uses a 5-point scale from &minus;2 to +2 with upvote and downvote controls. Tap the up arrow to vote +1, tap again to boost to +2, and tap a third time to clear. Downvoting works the same way in the other direction.</p>

    <p>Your implicit behavior also contributes to scoring. Starring an entry signals strong interest (+2), saving an article for later indicates moderate interest (+1), and marking an entry as read from the list without opening it indicates low interest (&minus;1). Explicit votes always take priority over implicit signals.</p>

    <h3>Server-Side Machine Learning</h3>

    <p>Once you&rsquo;ve rated at least 20 entries, Lion Reader trains a machine learning model to predict scores for new content. The model uses TF-IDF text vectorization with bigrams, combined with Ridge Regression. Titles are weighted 2x during feature extraction, and per-feed features capture your source-level preferences &mdash; so the model learns not just what topics you like, but which publications you trust.</p>

    <p>The model is cross-validated using Mean Absolute Error (MAE) and Pearson correlation metrics to ensure prediction quality. Predictions are tempered by a confidence score based on how well the model recognizes an entry&rsquo;s vocabulary and feed &mdash; uncertain predictions are pulled toward zero so they don&rsquo;t dominate your Best feed. New entries are automatically scored right after feed fetches, and the model retrains weekly as you continue rating.</p>

    <p>Scoring features:</p>
    <ul>
      <li><strong>Best feed</strong> &mdash; All unread entries sorted by predicted score</li>
      <li><strong>Explicit voting</strong> &mdash; &minus;2 to +2 scale with cycling up/down controls</li>
      <li><strong>Implicit signals</strong> &mdash; Starring (+2), saving (+1), quick-mark-read (&minus;1)</li>
      <li><strong>Server-side ML</strong> &mdash; TF-IDF with bigrams + Ridge Regression</li>
      <li><strong>Per-feed features</strong> &mdash; Learns source-level preferences</li>
      <li><strong>Confidence-based shrinkage</strong> &mdash; Uncertain predictions move toward zero</li>
      <li><strong>Automatic scoring</strong> &mdash; New entries scored after feed fetches, model retrains weekly</li>
    </ul>
  `,
};

export default article;
