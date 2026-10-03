/**
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DEMO_ENTRIES } from "@/app/(public)/demo/data";
import { htmlToClientNarration } from "@/lib/narration/client-paragraph-ids";
import {
  DEMO_NARRATION_MANIFEST_PATH,
  demoNarrationRecordings,
  demoNarrationText,
  toManifest,
} from "../../scripts/record-demo-narration";

describe("demo narration", () => {
  it.each(DEMO_ENTRIES.map((entry) => [entry.id, entry.contentHtml]))(
    "is recorded from the text the browser narrates: %s",
    (_id, html) => {
      expect(demoNarrationText(html)).toBe(htmlToClientNarration(html).narrationText);
    }
  );

  it("is recorded for the articles as they are (run `pnpm demo:narration`)", async () => {
    const recorded: unknown = JSON.parse(readFileSync(DEMO_NARRATION_MANIFEST_PATH, "utf8"));
    expect(recorded).toEqual(toManifest(await demoNarrationRecordings()));
  });
});
