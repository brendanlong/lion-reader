/**
 * Account export: a zip of everything that can't be re-created by subscribing
 * again elsewhere, in formats other tools read.
 *
 * - `index.html` — open in a browser to browse the export.
 * - `articles/<id>.html` — one standalone page per exported entry (see
 *   `listExportableEntries` for which), with the body the entry view shows.
 * - `entries.json` — the same entries' metadata, for scripts.
 * - `bookmarks.html` — a Netscape bookmark file of saved and starred links,
 *   which browsers and bookmark managers (Raindrop.io, linkding, Linkwarden) import.
 * - `subscriptions.opml` — the subscription list.
 *
 * Streamed one page of entries at a time so a large library never sits in memory.
 */

import type { db as dbType } from "@/server/db";
import { ZipWriter } from "@/server/file/zip-writer";
import { escapeHtml } from "@/server/http/html";
import { listExportableEntries, type ExportableEntry } from "./entries";
import { exportSubscriptionsOpml } from "./subscriptions";

/** @testonly */
export const EXPORT_PAGE_SIZE = 100;

type ExportedKind = "saved" | "upload" | "newsletter" | "feed";

interface ExportedEntryMetadata {
  id: string;
  kind: ExportedKind;
  url: string | null;
  title: string | null;
  author: string | null;
  siteName: string | null;
  feedTitle: string | null;
  summary: string | null;
  publishedAt: string | null;
  /** When the article was saved, or when the entry was fetched. */
  addedAt: string;
  read: boolean;
  starred: boolean;
  /** Path of the article's page within the zip. */
  file: string;
}

function entryKind(entry: ExportableEntry): ExportedKind {
  switch (entry.type) {
    case "saved":
      return entry.url === null ? "upload" : "saved";
    case "email":
      return "newsletter";
    case "web":
      return "feed";
  }
}

/** Only http(s) links are written as hrefs: the pages open from disk, where a `javascript:` URL would run. */
function linkableUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function displayTitle(entry: { title: string | null }): string {
  return entry.title?.trim() || "Untitled";
}

function htmlDocument(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>body{max-width:42rem;margin:2rem auto;padding:0 1rem;font-family:Georgia,serif;line-height:1.6}img,video{max-width:100%;height:auto}.meta{color:#666;font-family:system-ui,sans-serif;font-size:.9rem}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function renderArticle(entry: ExportableEntry): string {
  const source = entry.siteName ?? entry.feedTitle;
  const url = linkableUrl(entry.url);
  const date = (entry.publishedAt ?? entry.fetchedAt).toISOString().slice(0, 10);

  const meta = [
    entry.author ? escapeHtml(entry.author) : null,
    source ? escapeHtml(source) : null,
    date,
    url ? `<a href="${escapeHtml(url)}">Original</a>` : null,
  ].filter((part) => part !== null);

  return htmlDocument(
    displayTitle(entry),
    `<article>
<h1>${escapeHtml(displayTitle(entry))}</h1>
<p class="meta">${meta.join(" · ")}</p>
${entry.contentHtml ?? ""}
</article>`
  );
}

function toMetadata(entry: ExportableEntry): ExportedEntryMetadata {
  return {
    id: entry.id,
    kind: entryKind(entry),
    url: entry.url,
    title: entry.title,
    author: entry.author,
    siteName: entry.siteName,
    feedTitle: entry.feedTitle,
    summary: entry.summary,
    publishedAt: entry.publishedAt?.toISOString() ?? null,
    addedAt: entry.fetchedAt.toISOString(),
    read: entry.read,
    starred: entry.starred,
    file: `articles/${entry.id}.html`,
  };
}

const KIND_HEADINGS: Record<ExportedKind, string> = {
  saved: "Saved articles",
  upload: "Uploaded files",
  newsletter: "Newsletters",
  feed: "Starred feed entries",
};

function renderIndex(entries: ExportedEntryMetadata[], exportedAt: Date): string {
  const sections = (Object.keys(KIND_HEADINGS) as ExportedKind[]).flatMap((kind) => {
    const items = entries
      .filter((entry) => entry.kind === kind)
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    if (items.length === 0) return [];
    const list = items
      .map((entry) => {
        const source = entry.siteName ?? entry.feedTitle;
        return `<li><a href="${escapeHtml(entry.file)}">${escapeHtml(displayTitle(entry))}</a>${
          entry.starred ? " ★" : ""
        }${source ? ` <span class="meta">${escapeHtml(source)}</span>` : ""}</li>`;
      })
      .join("\n");
    return [`<h2>${KIND_HEADINGS[kind]} (${items.length})</h2>\n<ul>\n${list}\n</ul>`];
  });

  return htmlDocument(
    "Lion Reader export",
    `<h1>Lion Reader export</h1>
<p class="meta">Exported ${exportedAt.toISOString().slice(0, 10)}. Subscriptions are in subscriptions.opml, links in bookmarks.html, metadata in entries.json.</p>
${sections.length > 0 ? sections.join("\n") : "<p>No saved, starred or newsletter entries.</p>"}`
  );
}

function bookmarkLine(entry: ExportedEntryMetadata, url: string): string {
  const addDate = Math.floor(Date.parse(entry.addedAt) / 1000);
  const tags = entry.starred ? ` TAGS="starred"` : "";
  return `        <DT><A HREF="${escapeHtml(url)}" ADD_DATE="${addDate}"${tags}>${escapeHtml(
    displayTitle(entry)
  )}</A>`;
}

function bookmarkFolder(name: string, lines: string[], exportedAt: Date): string {
  const addDate = Math.floor(exportedAt.getTime() / 1000);
  return `    <DT><H3 ADD_DATE="${addDate}">${name}</H3>
    <DL><p>
${lines.join("\n")}
    </DL><p>`;
}

/** Saved articles in one folder, other starred links in another; entries without a web link are left out. */
function renderBookmarks(entries: ExportedEntryMetadata[], exportedAt: Date): string {
  const saved: string[] = [];
  const starred: string[] = [];
  for (const entry of entries) {
    const url = linkableUrl(entry.url);
    if (url === null) continue;
    if (entry.kind === "saved") saved.push(bookmarkLine(entry, url));
    else if (entry.starred) starred.push(bookmarkLine(entry, url));
  }

  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
${bookmarkFolder("Saved articles", saved, exportedAt)}
${bookmarkFolder("Starred", starred, exportedAt)}
</DL><p>
`;
}

export async function* streamLibraryExport(
  db: typeof dbType,
  userId: string,
  exportedAt: Date = new Date()
): AsyncGenerator<Uint8Array> {
  const zip = new ZipWriter();
  const exported: ExportedEntryMetadata[] = [];

  let afterId: string | null = null;
  do {
    const page = await listExportableEntries(db, userId, { afterId, limit: EXPORT_PAGE_SIZE });
    for (const entry of page.entries) {
      const metadata = toMetadata(entry);
      exported.push(metadata);
      yield await zip.addFile(metadata.file, renderArticle(entry), entry.fetchedAt);
    }
    afterId = page.nextAfterId;
  } while (afterId !== null);

  const { opml } = await exportSubscriptionsOpml(db, userId);
  yield await zip.addFile("subscriptions.opml", opml, exportedAt);
  yield await zip.addFile("entries.json", JSON.stringify(exported, null, 2), exportedAt);
  yield await zip.addFile("bookmarks.html", renderBookmarks(exported, exportedAt), exportedAt);
  yield await zip.addFile("index.html", renderIndex(exported, exportedAt), exportedAt);
  yield zip.finish();
}
