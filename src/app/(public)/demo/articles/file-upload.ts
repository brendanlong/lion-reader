import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "file-upload",
  subscriptionId: "feed-types",
  type: "saved",
  url: null,
  title: "File Upload",
  author: null,
  summary:
    "Upload Word documents, Markdown, or HTML files and read them alongside everything else.",
  publishedAt: new Date("2025-12-26T10:00:00Z"),
  starred: false,
  summaryHtml: `<p>Upload Word documents, Markdown, or HTML files and Lion Reader turns them into saved articles you can <strong>search, star, listen to, or summarize</strong>. Formatting like headings, lists, and links carries over, and the title is picked up automatically. Markdown files can set title, description, and author with a header.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-02"),
  contentHtml: `
    <p>Not everything you want to read lives on the web. Upload a Word document from a colleague, notes from your writing app, or an exported web page, and it becomes a <a href="/demo/all?entry=save-for-later">saved article</a> like any other &mdash; ready to <a href="/demo/all?entry=search">search</a>, star, <a href="/demo/all?entry=text-to-speech">listen to</a>, or <a href="/demo/all?entry=ai-summaries">summarize</a>.</p>

    <p>Lion Reader handles Word (.docx) documents, Markdown, and HTML. Headings, lists, links, and other formatting come through, and the title is picked up from the document automatically. On your phone, you can also <a href="/demo/all?entry=pwa">share a file</a> straight to Lion Reader from another app.</p>

    <details>
      <summary>Setting a title and author in Markdown</summary>
      <p>Markdown files can start with a short header to set the title, description, and author yourself:</p>
      <pre><code>---
title: My Article Title
description: A brief summary of the article
author: Jane Doe
---

# The actual content starts here...</code></pre>
    </details>
  `,
};

export default article;
