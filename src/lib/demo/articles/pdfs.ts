import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "pdfs",
  subscriptionId: "feed-types",
  type: "saved",
  url: "https://github.com/brendanlong/lion-reader/pull/2063",
  title: "Read PDFs Comfortably",
  author: null,
  summary:
    "Upload or save a PDF and read it as flowing text that fits your screen, with its pictures beside their captions.",
  publishedAt: new Date("2026-10-19T12:00:00Z"),
  score: 40,
  starred: false,
  summaryHtml: `<p>Lion Reader converts an uploaded or saved PDF into a flowing-text article that fits any screen, removing headers, footers, and page numbers and placing pictures above their captions. Charts drawn as shapes, full-page images, and password-protected files don&rsquo;t come through; scanned PDFs need searchable text.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-28"),
  contentHtml: `
    <p>PDFs are made for printing, which makes them a chore on a phone: you pinch, zoom, and scroll sideways down every column. Lion Reader turns a PDF into a regular article whose text flows to fit any screen, so a paper, report, or manual reads like everything else. Like any <a href="/demo/all?entry=save-for-later">saved article</a>, you can <a href="/demo/all?entry=search">search</a> it, <a href="/demo/all?entry=text-to-speech">listen to it</a>, or <a href="/demo/all?entry=ai-summaries">summarize</a> it.</p>

    <p>There are two ways in. <a href="/demo/all?entry=file-upload">Upload</a> a PDF from your computer, share one from another app on Android once you&rsquo;ve <a href="/demo/all?entry=pwa">installed Lion Reader</a>, or save a link to a PDF the way you&rsquo;d save any page &mdash; from the <a href="/demo/all?entry=browser-extension">browser extension</a>, your phone&rsquo;s share menu, or your <a href="/demo/all?entry=mcp-server">AI assistant</a>. If a site you follow links its posts to PDFs, <a href="/demo/all?entry=full-content">Full Content</a> brings in the whole document too.</p>

    <p>The conversion tidies up what only makes sense on paper: running headers, footers, and page numbers are removed, paragraphs split across a page break are joined back together, and most words hyphenated at the end of a line are made whole again. Headings stay headings, and an uploaded PDF takes its title from the document. Photos and other pictures appear just above their captions, while logos and other images repeated across pages are left out.</p>

    <details>
      <summary>What doesn&rsquo;t come through</summary>
      <ul>
        <li>Charts and diagrams drawn as lines and shapes, rather than embedded as pictures, are left out.</li>
        <li>Scanned PDFs &mdash; pictures of pages &mdash; can only be read if they already have searchable text in them.</li>
        <li>Images that fill a whole page, like a cover, are left out.</li>
        <li>Password-protected PDFs can&rsquo;t be opened.</li>
      </ul>
    </details>

    <p>Saving an arXiv paper from its PDF link gets you arXiv&rsquo;s own web version when there is one &mdash; see <a href="/demo/all?entry=plugins">smart content sources</a>. And if your book is an EPUB rather than a PDF, you can <a href="/demo/all?entry=books">import it with its chapters</a>.</p>
  `,
};

export default article;
