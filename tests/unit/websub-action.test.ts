/**
 * Unit tests for resolveWebsubAction - the pure decision that maps a feed's
 * previous WebSub state + the hub URL seen in the latest fetch to an action.
 */

import { describe, it, expect } from "vitest";
import { resolveWebsubAction } from "../../src/server/feed/websub";

const HUB_A = "https://hub-a.example.com/";
const HUB_B = "https://hub-b.example.com/";

describe("resolveWebsubAction", () => {
  it("subscribes when a hub appears and we're not active", () => {
    expect(
      resolveWebsubAction({
        previousHubUrl: null,
        previousWebsubActive: false,
        newHubUrl: HUB_A,
        canUseWebSub: true,
      })
    ).toBe("subscribe");
  });

  it("does nothing when there's no hub and we were never active", () => {
    expect(
      resolveWebsubAction({
        previousHubUrl: null,
        previousWebsubActive: false,
        newHubUrl: null,
        canUseWebSub: true,
      })
    ).toBe("none");
  });

  it("deactivates when the hub disappears while active", () => {
    expect(
      resolveWebsubAction({
        previousHubUrl: HUB_A,
        previousWebsubActive: true,
        newHubUrl: null,
        canUseWebSub: true,
      })
    ).toBe("deactivate");
  });

  it("does nothing when active and the hub is unchanged", () => {
    expect(
      resolveWebsubAction({
        previousHubUrl: HUB_A,
        previousWebsubActive: true,
        newHubUrl: HUB_A,
        canUseWebSub: true,
      })
    ).toBe("none");
  });

  it("resubscribes when the publisher switches to a different hub", () => {
    expect(
      resolveWebsubAction({
        previousHubUrl: HUB_A,
        previousWebsubActive: true,
        newHubUrl: HUB_B,
        canUseWebSub: true,
      })
    ).toBe("resubscribe");
  });

  it("does not resubscribe on a hub change when WebSub is unavailable", () => {
    // canUseWebSub false means we can't receive callbacks at all - stay on polling
    // rather than tearing down and failing to re-establish.
    expect(
      resolveWebsubAction({
        previousHubUrl: HUB_A,
        previousWebsubActive: true,
        newHubUrl: HUB_B,
        canUseWebSub: false,
      })
    ).toBe("none");
  });

  it("does not subscribe when a hub appears but WebSub is unavailable", () => {
    expect(
      resolveWebsubAction({
        previousHubUrl: null,
        previousWebsubActive: false,
        newHubUrl: HUB_A,
        canUseWebSub: false,
      })
    ).toBe("none");
  });

  it("still deactivates when the hub disappears even if WebSub is unavailable", () => {
    // We can always tear down local state; deactivation doesn't need a callback URL.
    expect(
      resolveWebsubAction({
        previousHubUrl: HUB_A,
        previousWebsubActive: true,
        newHubUrl: null,
        canUseWebSub: false,
      })
    ).toBe("deactivate");
  });

  it("subscribes when a hub is present but a prior subscription went inactive", () => {
    // e.g. a previous renewal failed and marked websubActive false; the hub is
    // still advertised, so we should try again.
    expect(
      resolveWebsubAction({
        previousHubUrl: HUB_A,
        previousWebsubActive: false,
        newHubUrl: HUB_A,
        canUseWebSub: true,
      })
    ).toBe("subscribe");
  });
});
