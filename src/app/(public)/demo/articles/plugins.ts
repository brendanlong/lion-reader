import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "plugins",
  subscriptionId: "integrations",
  type: "web",
  url: null,
  title: "Smart Content Sources",
  author: null,
  summary:
    "Links from YouTube, arXiv, GitHub, Google Docs, and other sites come through complete and readable, whether you subscribe or save them.",
  publishedAt: new Date("2026-01-20T12:00:00Z"),
  starred: true,
  summaryHtml: `<p>Lion Reader recognizes popular sites and pulls in their full content automatically when you subscribe or save a link: playable <strong>YouTube</strong> videos, <strong>arXiv</strong> papers in HTML when available, full GitHub READMEs, intact Google Docs, complete Notion pages, and Bluesky posts with their embeds. It also renders equations that would otherwise go missing.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Plenty of the web doesn&rsquo;t fit neatly into a feed &mdash; and even when it does, the feed often leaves out the parts you actually wanted. Lion Reader recognizes many popular sites and pulls in their content complete and easy to read, whether you&rsquo;re subscribing or <a href="/demo/all?entry=save-for-later">saving something for later</a>. You don&rsquo;t have to do anything special: paste a link and Lion Reader takes care of the rest. A few examples:</p>

    <ul>
      <li><strong>YouTube</strong> &mdash; subscribe to a channel, or save a video, and get a playable video with its full description.</li>
      <li><strong>Bluesky</strong> &mdash; follow any profile and see the quoted posts, images, and link cards that Bluesky&rsquo;s own feed reduces to a bare &ldquo;embedded content&rdquo; note.</li>
      <li><strong>arXiv</strong> &mdash; save a paper from its abstract or PDF link and read arXiv&rsquo;s HTML version when there is one, instead of squinting at a PDF.</li>
      <li><strong>GitHub</strong> &mdash; save a repository, file, or gist and its README or Markdown reads like a proper page.</li>
      <li><strong>Google Docs</strong> &mdash; save a doc with its formatting intact, instead of a sign-in page.</li>
      <li><strong>Notion</strong> &mdash; save a published Notion page and get the whole document, where a normal save gets a blank page.</li>
      <li><strong>LessWrong</strong> &mdash; follow an author&rsquo;s posts or a post&rsquo;s comment thread, with full text and rendered math.</li>
    </ul>

    <p>New sources are added regularly, and they work everywhere you save from: the web app, your <a href="/demo/all?entry=mcp-server">AI assistant</a>, and the <a href="/demo/all?entry=discord-bot">Discord bot</a>.</p>

    <h3>Math That Actually Renders</h3>

    <p>Some sites, like LessWrong, publish equations in a form most readers can&rsquo;t display, so sentences arrive with the math missing. Lion Reader converts them into math your browser draws natively and crisply, and Markdown you save or upload can include math too. Like this:</p>

    <math display="block">
      <mrow>
        <mi>x</mi>
        <mo>=</mo>
        <mfrac>
          <mrow>
            <mo>&minus;</mo>
            <mi>b</mi>
            <mo>&plusmn;</mo>
            <msqrt>
              <mrow>
                <msup><mi>b</mi><mn>2</mn></msup>
                <mo>&minus;</mo>
                <mn>4</mn>
                <mi>a</mi>
                <mi>c</mi>
              </mrow>
            </msqrt>
          </mrow>
          <mrow>
            <mn>2</mn>
            <mi>a</mi>
          </mrow>
        </mfrac>
      </mrow>
    </math>
  `,
};

export default article;
