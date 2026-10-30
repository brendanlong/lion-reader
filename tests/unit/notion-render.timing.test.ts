/** Wall-clock budget for rendering a Notion page that fans out. */

import { describe, it, expect } from "vitest";
import type { NotionBlock } from "../../src/server/notion/api";
import { NotionRenderTooLargeError, renderNotionPage } from "../../src/server/notion/render";
import { BASE_URL, block, page, PAGE_ID, text } from "../utils/notion-blocks";

describe("renderNotionPage output budget", () => {
  it("cuts off a synced-block chain that fans out exponentially", () => {
    // Container N holds two references to container N+1; the last holds a
    // paragraph. 2^links leaf expansions from a handful of blocks.
    const leaf = block("text", { title: text("leaf ".repeat(20)) });
    const extra: NotionBlock[] = [leaf];
    let next = block("transclusion_container", {}, { content: [leaf.id] });
    extra.push(next);
    for (let i = 0; i < 30; i++) {
      const ref = (target: string) =>
        block(
          "transclusion_reference",
          {},
          { format: { transclusion_reference_pointer: { id: target, table: "block" } } }
        );
      const a = ref(next.id);
      const b = ref(next.id);
      next = block("transclusion_container", {}, { content: [a.id, b.id] });
      extra.push(a, b, next);
    }
    const map = page([next], extra);
    const started = performance.now();
    expect(() => renderNotionPage(map, PAGE_ID, BASE_URL, { maxHtmlLength: 100_000 })).toThrow(
      NotionRenderTooLargeError
    );
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
