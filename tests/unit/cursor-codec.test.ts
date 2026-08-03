import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createCursorCodec, cursorUuid } from "@/server/services/cursor";

const codec = createCursorCodec(z.object({ ts: z.string(), id: cursorUuid }));

const UUID = "01890a5d-ac96-774b-bcce-b302099a8057";

describe("cursor codec", () => {
  it("round-trips a tuple", () => {
    const cursor = codec.encode({ ts: "2026-08-02T12:00:00.123456Z", id: UUID });
    expect(codec.decode(cursor)).toEqual({ ts: "2026-08-02T12:00:00.123456Z", id: UUID });
  });

  it("encodes with the URL-safe alphabet", () => {
    // Some clients (e.g. Read You) concatenate the Google Reader `continuation`
    // token into a query string without URL-encoding, where a standard-base64
    // "+" would arrive as a space and corrupt the cursor.
    const cursor = codec.encode({ ts: "ÿþýüûú", id: UUID });
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it("decodes cursors emitted in the standard base64 alphabet", () => {
    const payload = JSON.stringify({ ts: "2026-08-02T12:00:00Z", id: UUID });
    const standard = Buffer.from(payload, "utf8").toString("base64");
    expect(codec.decode(standard)).toEqual({ ts: "2026-08-02T12:00:00Z", id: UUID });
  });

  it("rejects a cursor that isn't base64 JSON", () => {
    expect(() => codec.decode("not-a-cursor")).toThrow(/Invalid cursor format/);
  });

  it("rejects a cursor whose id is not a UUID", () => {
    // A non-UUID would otherwise reach Postgres as "invalid input syntax for
    // type uuid" and 500 instead of being a validation error.
    const cursor = Buffer.from(JSON.stringify({ ts: "x", id: "1; DROP TABLE" })).toString(
      "base64url"
    );
    expect(() => codec.decode(cursor)).toThrow(/Invalid cursor format/);
  });

  it("rejects a cursor missing a required field", () => {
    const cursor = Buffer.from(JSON.stringify({ id: UUID })).toString("base64url");
    expect(() => codec.decode(cursor)).toThrow(/Invalid cursor format/);
  });

  it("applies schema defaults to absent optional fields", () => {
    const titleCodec = createCursorCodec(
      z.object({ title: z.string().nullable().default(null), id: cursorUuid })
    );
    const cursor = Buffer.from(JSON.stringify({ id: UUID })).toString("base64url");
    expect(titleCodec.decode(cursor)).toEqual({ title: null, id: UUID });
  });
});
