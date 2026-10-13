import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "save-for-later",
  subscriptionId: "feed-types",
  type: "saved",
  url: "https://github.com/brendanlong/lion-reader/pull/57",
  title: "Save for Later",
  author: null,
  summary:
    "Save any page to read later, from wherever you find it. Lion Reader keeps a clean, readable copy that won't disappear.",
  publishedAt: new Date("2025-12-27T16:00:00Z"),
  starred: true,
  summaryHtml: `<p>Saving an article to Lion Reader keeps a clean, ad-free copy that stays readable even if the original disappears. Save it from the browser extension, a phone&rsquo;s share menu, a file, or the Discord bot, and tricky pages like <strong>YouTube</strong> videos or Google Docs come through as real content.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>Found something you want to read later? Save it to Lion Reader and you get a clean, readable copy &mdash; no ads, no pop-ups, no sidebar clutter &mdash; in the same place as your newsletters and the sites you follow. Lion Reader keeps its own copy, so the article stays readable even if the original page changes or disappears.</p>

    <h3>Save From Anywhere</h3>

    <ul>
      <li><strong>In your browser</strong> &mdash; one click with the <a href="/demo/all?entry=browser-extension">browser extension</a>, or a bookmarklet in any browser</li>
      <li><strong>On your phone</strong> &mdash; from the share menu: on Android, <a href="/demo/all?entry=pwa">install Lion Reader like an app</a>; on iPhone and iPad, use the free <a href="/demo/all?entry=wallabag-api">Wallabag app</a></li>
      <li><strong>From a file</strong> &mdash; <a href="/demo/all?entry=file-upload">upload</a> a Word document, Markdown, or HTML file</li>
      <li><strong>In Discord</strong> &mdash; react to a link with the <a href="/demo/all?entry=discord-bot">Discord bot</a></li>
      <li><strong>By asking</strong> &mdash; tell your <a href="/demo/all?entry=mcp-server">AI assistant</a> to save it for you</li>
    </ul>

    <h3>Videos, Docs, and Other Tricky Pages</h3>

    <p>Some pages don&rsquo;t save well the usual way. Lion Reader recognizes many popular sites and brings in the real content &mdash; a YouTube video you can play, a Google Doc with its formatting, a GitHub project&rsquo;s README &mdash; instead of a stripped-down page. See <a href="/demo/all?entry=plugins">smart content sources</a> for more. Paywalled articles save only the part anyone can see without logging in.</p>

    <h3>Part of Your Library</h3>

    <p>Saved articles get their own section in the sidebar, and you can star, <a href="/demo/all?entry=search">search</a>, <a href="/demo/all?entry=text-to-speech">listen to</a>, or <a href="/demo/all?entry=ai-summaries">summarize</a> them like anything else. Mark one read when you&rsquo;re done and it leaves your unread list.</p>
  `,
};

export default article;
