import { describe, it, expect } from "vitest";
import { DEMO_ENTRIES, DEMO_TAGS, DEMO_SUBSCRIPTIONS } from "@/app/demo/data";

/**
 * Demo plain-text metadata invariant (double-encoding guard).
 *
 * These fields are rendered as React text children (e.g. DemoEntryListSSR's
 * `{entry.summary}`) and handed to Next's `generateMetadata` as the page
 * `description`/`title`. In both places React/Next HTML-escape the value
 * exactly once, so a literal apostrophe `'` correctly becomes `&#x27;` (which
 * a browser/crawler decodes back to `'`).
 *
 * The footgun: the sibling `summaryHtml`/`contentHtml` fields legitimately
 * contain pre-encoded HTML entities (`&#39;`, `&rsquo;`, `&amp;`, ...). If one
 * of those is copied into a plain-text field, React escapes the leading `&`
 * again — `&#39;` → `&amp;#39;` — and the entity shows up verbatim in the meta
 * description / list (the "Lion Reader&#39;s features:" double-encoding). Keep
 * these fields plain text: no HTML entities, no raw tags. A bare `&` (e.g.
 * "Organization & Search") is fine — it's not a `;`-terminated entity.
 */

// Matches HTML character references: named (&amp;), decimal (&#39;), hex (&#x27;).
const HTML_ENTITY = /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/;

const PLAIN_TEXT_FIELDS: { label: string; value: string | null | undefined }[] = [
  ...DEMO_ENTRIES.flatMap((e) => [
    { label: `entry[${e.id}].title`, value: e.title },
    { label: `entry[${e.id}].summary`, value: e.summary },
  ]),
  ...DEMO_TAGS.flatMap((t) => [
    { label: `tag[${t.id}].name`, value: t.name },
    { label: `tag[${t.id}].description`, value: t.description },
  ]),
  ...DEMO_SUBSCRIPTIONS.flatMap((s) => [
    { label: `subscription[${s.id}].title`, value: s.title },
    { label: `subscription[${s.id}].description`, value: s.description },
  ]),
];

describe("demo plain-text metadata fields", () => {
  it("has fields to check", () => {
    // Guard against the arrays silently becoming empty (which would make the
    // per-field assertions below vacuously pass).
    expect(PLAIN_TEXT_FIELDS.length).toBeGreaterThan(0);
  });

  it.each(PLAIN_TEXT_FIELDS)(
    "$label contains no HTML entities (would double-encode as metadata/text)",
    ({ value }) => {
      if (value == null) return;
      expect(value).not.toMatch(HTML_ENTITY);
    }
  );

  it.each(PLAIN_TEXT_FIELDS)("$label contains no raw HTML tags", ({ value }) => {
    if (value == null) return;
    expect(value).not.toMatch(/<[a-zA-Z/]/);
  });
});
