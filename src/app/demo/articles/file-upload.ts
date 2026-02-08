import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "file-upload",
  subscriptionId: "feed-types",
  type: "saved",
  url: null,
  title: "File Upload",
  author: null,
  summary:
    "Upload Word documents, Markdown files, HTML, and plain text directly into your reading library.",
  publishedAt: new Date("2025-12-26T10:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader supports uploading Word documents (.docx), Markdown files (.md), HTML files (.html), and plain text (.txt) directly into your saved articles. Word documents are converted via Mammoth with Readability cleaning, Markdown supports YAML frontmatter for metadata, and all uploaded content integrates fully with starring, tagging, search, and narration.</p>`,
  contentHtml: `
    <p>Beyond saving web pages, Lion Reader lets you upload files directly into your reading library. Whether it&rsquo;s a Word document from a colleague, Markdown notes from your writing tool, an HTML export, or a plain text file &mdash; uploaded content becomes a first-class saved article with all the same features: starring, tagging, search, narration, and AI summaries.</p>

    <h3>Supported File Types</h3>

    <p>Lion Reader supports four file formats for upload:</p>

    <ul>
      <li><strong>Word documents (.docx)</strong> &mdash; Converted to clean HTML using <a href="https://github.com/mwilliamson/mammoth.js" target="_blank" rel="noopener noreferrer">Mammoth</a>, then refined with Mozilla&rsquo;s Readability algorithm. Document styles like Title and Subtitle are mapped to proper HTML headings, preserving your document&rsquo;s structure.</li>
      <li><strong>Markdown (.md, .markdown)</strong> &mdash; Rendered to HTML with full Markdown syntax support. YAML frontmatter is extracted for metadata: set <code>title</code>, <code>description</code>, and <code>author</code> fields and they&rsquo;ll be used automatically.</li>
      <li><strong>HTML (.html, .htm)</strong> &mdash; Cleaned with Readability to extract the main content, stripping navigation, ads, and other chrome &mdash; just like saving a web page.</li>
      <li><strong>Plain text (.txt)</strong> &mdash; Treated as Markdown, so you get paragraph wrapping and basic formatting. Simple and effective for notes and snippets.</li>
    </ul>

    <h3>Markdown Frontmatter</h3>

    <p>Markdown files can include YAML frontmatter to provide metadata that Lion Reader will use instead of guessing from the content:</p>

    <pre><code>---
title: My Article Title
description: A brief summary of the article
author: Jane Doe
---

# The actual content starts here...</code></pre>

    <p>Without frontmatter, Lion Reader extracts the title from the first heading in the document or falls back to the filename. The summary is generated automatically from the content.</p>

    <h3>How Uploaded Content Appears</h3>

    <p>Uploaded articles appear in the Saved section of your sidebar alongside web-saved articles. They&rsquo;re displayed with the same clean reading view and support all the features you&rsquo;d expect: full-text search finds content inside uploaded documents, narration can read them aloud, and AI summaries work on uploaded content just like any other article. The only difference is that uploaded articles don&rsquo;t have a source URL &mdash; the content lives entirely within Lion Reader.</p>
  `,
};

export default article;
