/**
 * @vitest-environment jsdom
 */

/**
 * The account settings Plan section: usage is shown against the plan's limit,
 * a limit the plan doesn't have isn't shown as one, quotas show their rate, and
 * AI quotas say when only the user's own key can be used.
 */

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { PlanSection } from "@/components/settings/pages/AccountSettingsContent";
import { renderWithTrpc } from "../../../utils/component-test-helpers";

describe("PlanSection", () => {
  it("shows usage against each limit and each quota's rate", async () => {
    renderWithTrpc(<PlanSection />, {
      handlers: {
        "users.me.plan": () => ({
          plan: "free",
          limits: {
            maxSubscriptions: 150,
            maxIngestAddresses: null,
            serverKeyModels: [],
            quotas: {
              pageFetches: { burst: 50, perDay: 200 },
              fileConversions: null,
              summaries: null,
              narrationTextProcessing: null,
              speechCharacters: null,
            },
          },
          usage: { subscriptions: 12, ingestAddresses: 3 },
        }),
      },
    });

    expect(await screen.findByText("Free")).toBeTruthy();
    expect(screen.getByText("12 of 150")).toBeTruthy();
    expect(screen.getByText("3 (no limit)")).toBeTruthy();
    expect(screen.getByText("200 a day, up to 50 at once")).toBeTruthy();
    expect(screen.getByText("No limit")).toBeTruthy();
    // A plan with no models on the server's keys has AI only on the user's own.
    expect(screen.getAllByText("With your own API key only")).toHaveLength(3);
  });
});
