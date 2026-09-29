import { describe, it, expect } from "vitest";
import { toServerTime } from "../../src/server/services/client-time";

const now = new Date("2026-09-29T12:00:00Z");

describe("toServerTime", () => {
  it("uses the server's now when the client sent no timestamp", () => {
    expect(toServerTime(undefined, undefined, now)).toEqual(now);
  });

  it("keeps a past timestamp from a client that didn't report its clock", () => {
    const changedAt = new Date("2026-09-29T11:00:00Z");
    expect(toServerTime(changedAt, undefined, now)).toEqual(changedAt);
  });

  it("caps a future timestamp at now", () => {
    expect(toServerTime(new Date("2026-09-30T00:00:00Z"), undefined, now)).toEqual(now);
  });

  it("shifts by the offset of a fast client clock", () => {
    // Client clock is 1h fast; it recorded the change 10 min before sending.
    const clientSentAt = new Date("2026-09-29T13:00:00Z");
    const changedAt = new Date("2026-09-29T12:50:00Z");
    expect(toServerTime(changedAt, clientSentAt, now)).toEqual(new Date("2026-09-29T11:50:00Z"));
  });

  it("shifts by the offset of a slow client clock, still capped at now", () => {
    // Client clock is 1h slow; a change it stamped as just now maps to now.
    const clientSentAt = new Date("2026-09-29T11:00:00Z");
    expect(toServerTime(clientSentAt, clientSentAt, now)).toEqual(now);
  });
});
