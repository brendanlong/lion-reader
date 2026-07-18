import { describe, expect, it } from "vitest";
import { formatDate } from "@/components/entries/EntryContentHelpers";

describe("formatDate timeZone", () => {
  // An instant that lands on different calendar days depending on the zone,
  // which is exactly the case that made the demo's SSR (UTC host) disagree with
  // the client (local zone). An explicit zone makes the output deterministic.
  const instant = new Date("2026-07-18T00:55:00Z");

  it("formats in an explicit IANA zone regardless of the host zone", () => {
    expect(formatDate(instant, "America/Los_Angeles")).toBe("Friday, July 17, 2026 at 5:55 PM");
    expect(formatDate(instant, "UTC")).toBe("Saturday, July 18, 2026 at 12:55 AM");
  });

  it("is stable for the same zone (server and client would match)", () => {
    expect(formatDate(instant, "America/Los_Angeles")).toBe(
      formatDate(instant, "America/Los_Angeles")
    );
  });
});
