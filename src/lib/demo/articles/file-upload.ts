import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "file-upload",
  subscriptionId: "feed-types",
  type: "saved",
  url: null,
  title: "File Upload",
  author: null,
  summary:
    "Upload Word documents, PDFs, ebooks, Markdown, or HTML files and read them alongside everything else.",
  publishedAt: new Date("2025-12-26T10:00:00Z"),
  score: 130,
  starred: false,
  summaryHtml: `<p>Upload Word, PDF, ebook, Markdown, HTML, or text files and they become private saved articles you can search, star, listen to, or summarize, with formatting and title preserved. PDFs become flowing text, ebooks become chapter-by-chapter collections, and Markdown headers can set the title, description, and author.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-28"),
  contentHtml: `
    <p>Not everything you want to read lives on the web. Upload a Word document or PDF someone emailed you, notes you wrote in Markdown, or a web page you saved as a file, and it becomes a <a href="/demo/all?entry=save-for-later">saved article</a> like any other &mdash; ready to <a href="/demo/all?entry=search">search</a>, star, <a href="/demo/all?entry=text-to-speech">listen to</a>, or <a href="/demo/all?entry=ai-summaries">summarize</a>. Only you can see your uploads.</p>

    <p>Use the upload button at the top of the app to add a Word (.docx), PDF, ebook (.epub), Markdown, HTML, or plain text file. Headings, lists, links, and other formatting come through, and the title is picked up from the document automatically. You can also file the upload straight into a <a href="/demo/all?entry=collections">collection</a>.</p>

    <p>PDFs become flowing text you can read comfortably on any screen, with the running headers and page numbers left behind &mdash; see <a href="/demo/all?entry=pdfs">Read PDFs Comfortably</a>. An ebook becomes a collection with one article per chapter, in reading order &mdash; see <a href="/demo/all?entry=books">Read Books</a>.</p>

    <details>
      <summary>Setting a title and author in Markdown</summary>
      <p>Markdown files can start with a short header to set the title, description, and author yourself:</p>
      <pre><code>---
title: My Article Title
description: A brief summary of the article
author: Jane Doe
---

# The actual content starts here...</code></pre>
      <p>Markdown can include math, too, and it displays as properly typeset equations.</p>
    </details>

    <p>On your phone, you can also <a href="/demo/all?entry=pwa">share a file</a> straight to Lion Reader from another app.</p>
  `,
};

export default article;
