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
  summaryHtml: `<p>Lion Reader recognizes popular sites and pulls in their content complete and readable instead of a sign-in page or blank page &mdash; a playable <strong>YouTube</strong> video, a formatted Google Doc, and a readable GitHub README, among others. This works however you save or follow a site, with no extra steps.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Plenty of the web doesn&rsquo;t save or subscribe well the usual way &mdash; you get a sign-in page, a blank page, or a feed that leaves out the parts you wanted. Lion Reader recognizes many popular sites and pulls in their content complete and easy to read, whether you&rsquo;re <a href="/demo/all?entry=rss-atom">following a site</a> or <a href="/demo/all?entry=save-for-later">saving something for later</a>. You don&rsquo;t have to do anything special: follow or save the link as usual and Lion Reader takes care of the rest. A few examples:</p>

    <ul>
      <li><strong>YouTube</strong> &mdash; subscribe to a channel, or save a video, and get a playable video with its full description.</li>
      <li><strong>Google Docs</strong> &mdash; save a doc with its formatting intact, instead of a sign-in page.</li>
      <li><strong>Notion</strong> &mdash; save a published Notion page and get the whole document, where a normal save gets a blank page.</li>
      <li><strong>Bluesky</strong> &mdash; follow any profile and see the quoted posts, images, and link previews that Bluesky&rsquo;s own feed leaves out.</li>
      <li><strong>GitHub</strong> &mdash; save a project or file and its README reads like a proper page.</li>
      <li><strong>arXiv</strong> &mdash; save a paper from its abstract or PDF link and read arXiv&rsquo;s HTML version when there is one, instead of squinting at a PDF.</li>
      <li><strong>LessWrong</strong> &mdash; follow an author&rsquo;s posts or a post&rsquo;s comment thread, with full text and properly displayed math.</li>
    </ul>

    <p>This works however you save &mdash; the browser extension, your phone, Discord, or your AI assistant &mdash; and sites that aren&rsquo;t on the list still get a clean, readable copy.</p>

    <details>
      <summary>Math that displays properly</summary>
      <p>Some sites, like LessWrong, publish equations in a form most readers can&rsquo;t display, so sentences arrive with the math missing. Lion Reader converts them into math your browser draws natively and crisply, like this:</p>

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
    </details>
  `,
};

export default article;
