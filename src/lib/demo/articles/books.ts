import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "books",
  subscriptionId: "feed-types",
  type: "saved",
  url: "https://github.com/brendanlong/lion-reader/pull/2102",
  title: "Read Books",
  author: null,
  summary:
    "Upload an ebook and read or listen to it a chapter at a time, in order, with its pictures intact.",
  publishedAt: new Date("2026-10-28T12:00:00Z"),
  score: 20,
  starred: false,
  summaryHtml: `<p>Uploading an .epub turns the book into a collection with one article per chapter in reading order, keeping its pictures and chapter titles. Finished chapters drop off your unread list. DRM-free books work; each chapter is a saved article you can listen to, search, or summarize.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-28"),
  contentHtml: `
    <p>Have an ebook you&rsquo;ve been meaning to get to? Upload it and Lion Reader turns it into a <a href="/demo/all?entry=collections">collection</a> named for the book, with each chapter as its own article in reading order. Open the collection and the book starts at chapter one. Chapters you&rsquo;ve read drop off your unread list, so the next one you haven&rsquo;t read is always at the top.</p>

    <p>Use the upload button at the top of the app and pick an .epub file, or on Android, share it to Lion Reader from another app once you&rsquo;ve <a href="/demo/all?entry=pwa">installed it</a>. Chapter titles come from the book&rsquo;s table of contents, the author comes from the book, and its pictures come along too.</p>

    <details>
      <summary>Which books work</summary>
      <p>Lion Reader imports ebooks in the .epub format, with up to 1,000 chapters. Books locked with DRM, as many stores sell them, can&rsquo;t be imported; DRM-free books, like the ones from Project Gutenberg or Standard Ebooks, work. If an import is interrupted, the chapters it already added stay in order, and uploading the same file again adds just the ones still missing.</p>
    </details>

    <p>Each chapter is a <a href="/demo/all?entry=save-for-later">saved article</a> like any other, so you can <a href="/demo/all?entry=text-to-speech">listen to it</a>, <a href="/demo/all?entry=search">search</a> it, star it, or <a href="/demo/all?entry=ai-summaries">summarize</a> it. When you finish a chapter, swipe or press <a href="/demo/all?entry=keyboard-shortcuts"><kbd>j</kbd></a> to go on to the next.</p>

    <p>Done with a book? Delete its collection and check the box to delete its chapters along with it.</p>
  `,
};

export default article;
