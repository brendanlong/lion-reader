/**
 * @vitest-environment jsdom
 */

/**
 * The account settings Plan section: usage is shown against the plan's limit,
 * a limit the plan doesn't have isn't shown as one, quotas show their rate, and
 * AI features the plan excludes say only the user's own key can be used.
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
            serverKeyRouting: "cheapest",
            backgroundFullContent: false,
            quotas: {
              pageFetches: { burst: 50, perDay: 200 },
              fileConversions: null,
              summaries: { burst: 3, perDay: 5 },
              narrationTextProcessing: "excluded",
              speechCharacters: null,
              newsletterEmails: null,
            },
          },
          serverKeyModels: null,
          usage: { subscriptions: 12, ingestAddresses: 3 },
        }),
      },
    });

    expect(await screen.findByText("Free")).toBeTruthy();
    expect(screen.getByText("12 of 150")).toBeTruthy();
    expect(screen.getByText("3 (no limit)")).toBeTruthy();
    expect(screen.getByText("200 a day, up to 50 at once")).toBeTruthy();
    expect(screen.getAllByText("No limit")).toHaveLength(3);
    expect(screen.getByText("Fetched as you open each article")).toBeTruthy();
    expect(screen.getByText("5 a day, up to 3 at once")).toBeTruthy();
    // A feature the plan excludes works only on the user's own key.
    expect(screen.getByText("With your own API key only")).toBeTruthy();
  });
});
