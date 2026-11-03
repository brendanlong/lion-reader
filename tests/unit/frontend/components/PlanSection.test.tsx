/**
 * @vitest-environment jsdom
 */

/**
 * The account settings Plan section: usage is shown against the plan's limit,
 * and a limit the plan doesn't have isn't shown as one.
 */

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { PlanSection } from "@/components/settings/pages/AccountSettingsContent";
import { renderWithTrpc } from "../../../utils/component-test-helpers";

describe("PlanSection", () => {
  it("shows usage against each limit, and bare usage where there's no limit", async () => {
    renderWithTrpc(<PlanSection />, {
      handlers: {
        "users.me.plan": () => ({
          plan: "free",
          limits: { maxSubscriptions: 150, maxIngestAddresses: null },
          usage: { subscriptions: 12, ingestAddresses: 3 },
        }),
      },
    });

    expect(await screen.findByText("Free")).toBeTruthy();
    expect(screen.getByText("12 of 150")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });
});
