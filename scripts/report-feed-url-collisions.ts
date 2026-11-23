/**
 * Counts feeds whose stored URLs would collide once normalized (the app's
 * `linkableUrl` href, fragment cleared), to size a feeds.url normalization.
 *
 * Usage: pnpm exec tsx scripts/report-feed-url-collisions.ts feeds.tsv
 *
 * The input is tab-separated `id`, `url`, `active subscriber count` rows
 * (psql `\copy ... TO` output). Prints counts and generic patterns only, never
 * a URL: feed URLs can carry private tokens.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "node:url";
import { linkableUrl } from "../src/server/http/linkable-url";

interface Feed {
  url: string;
  subscribers: number;
}

function normalize(url: string): string | null {
  const href = linkableUrl(url);
  if (href === null) return null;
  const parsed = new URL(href);
  parsed.hash = "";
  return parsed.href;
}

/** Generic reasons a stored URL differs from its normalized form. */
function patterns(url: string, normalized: string): string[] {
  const found: string[] = [];
  if (url !== url.trim() || /[\u0000-\u001f\u007f]/.test(url)) found.push("whitespace/control");
  if (url.includes("#")) found.push("fragment");
  const raw = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(url.trim());
  if (raw) {
    const [, scheme, authority] = raw;
    if (scheme !== scheme.toLowerCase()) found.push("scheme case");
    const host = authority.replace(/^.*@/, "");
    if (/:(80|443)$/.test(host)) found.push("default port");
    if (host !== host.toLowerCase()) found.push("host case");
    if (/[^\x00-\x7f]/.test(host)) found.push("non-ASCII host");
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*[/]/i.test(url.trim()) && normalized.endsWith("/"))
      found.push("bare origin (no path)");
  }
  if (/[^\x00-\x7f]|[ "<>`{}|\\^]/.test(url.replace(/^[^/]*\/\/[^/]*/, "")))
    found.push("path/query encoding");
  if (/\/\.\.?(\/|$)/.test(url)) found.push("dot segments");
  return found.length > 0 ? found : ["other"];
}

function main(file: string): void {
  const feeds = new Map<string, Feed>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line === "") continue;
    const [id, url, subscribers] = line.split("\t");
    feeds.set(id, { url, subscribers: Number(subscribers) });
  }

  const groups = new Map<string, Feed[]>();
  const changed = new Map<string, number>();
  let unusable = 0;
  let unusableSubscribed = 0;
  for (const feed of feeds.values()) {
    const normalized = normalize(feed.url);
    if (normalized === null) {
      unusable++;
      if (feed.subscribers > 0) unusableSubscribed++;
      continue;
    }
    if (normalized !== feed.url) {
      for (const pattern of patterns(feed.url, normalized)) {
        changed.set(pattern, (changed.get(pattern) ?? 0) + 1);
      }
    }
    groups.set(normalized, [...(groups.get(normalized) ?? []), feed]);
  }

  const collisions = [...groups.values()].filter((group) => group.length > 1);
  const changedCount = [...feeds.values()].filter((feed) => {
    const normalized = normalize(feed.url);
    return normalized !== null && normalized !== feed.url;
  }).length;

  console.log(`feeds: ${feeds.size}`);
  console.log(`not http(s) or unparseable: ${unusable} (${unusableSubscribed} with subscribers)`);
  console.log(`would change when normalized: ${changedCount}`);
  for (const [pattern, count] of [...changed].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pattern}: ${count}`);
  }
  console.log(`collision groups: ${collisions.length}`);
  console.log(`feeds in collision groups: ${collisions.reduce((n, g) => n + g.length, 0)}`);
  console.log("per group (feeds; subscribers per feed):");
  for (const group of collisions) {
    const counts = group.map((feed) => feed.subscribers).sort((a, b) => b - a);
    const why = [...new Set(group.flatMap((feed) => patterns(feed.url, normalize(feed.url)!)))];
    console.log(`  ${group.length}; ${counts.join(", ")}  [${why.join(", ")}]`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: pnpm exec tsx scripts/report-feed-url-collisions.ts feeds.tsv");
    process.exit(1);
  }
  main(file);
}
