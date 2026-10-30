/** Builders for the Notion block maps `renderNotionPage` reads. */

import type { NotionBlock, NotionBlockMap } from "../../src/server/notion/api";

export const PAGE_ID = "37bb1284-725b-81c6-9167-c4b2a67c26e1";
export const BASE_URL = new URL(
  `https://handbook.sparai.org/How-to-succeed-in-SPAR-${PAGE_ID.replace(/-/g, "")}`
);

let counter = 0;
export function block(
  type: string,
  properties: Record<string, unknown> = {},
  extra: Partial<NotionBlock> = {}
): NotionBlock {
  counter += 1;
  return {
    id: `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`,
    type,
    properties,
    ...extra,
  };
}

export function text(content: string, decorations?: unknown[]): unknown[] {
  return decorations ? [[content, decorations]] : [[content]];
}

/** Build a page whose body is `children`, in order, plus any extra blocks. */
export function page(
  children: NotionBlock[],
  extra: NotionBlock[] = [],
  title = "Test page"
): NotionBlockMap {
  const root: NotionBlock = {
    id: PAGE_ID,
    type: "page",
    properties: { title: text(title) },
    content: children.map((c) => c.id),
  };
  const map: NotionBlockMap = new Map([[PAGE_ID, root]]);
  for (const b of [...children, ...extra]) map.set(b.id, b);
  return map;
}
