/**
 * E2E test for the global announcement banner SSE push.
 *
 * Verifies the full pipeline for the `announcement_changed` broadcast:
 * Redis (global site-status channel) → SSE endpoint → EventSource →
 * handleSyncEvent → announcement store → root-layout banner — and that it
 * updates the open tab live without any entries/tags/subscriptions refetch.
 */

import { test, expect } from "@playwright/test";
import { publishAnnouncementChanged, getSiteStatusChannel } from "../../src/server/redis/pubsub";
import {
  getDb,
  createConfirmedUser,
  loginAs,
  waitForChannelSubscriber,
  recordTrpcProcedures,
  closeTestConnections,
} from "./helpers";

test.afterAll(async () => {
  await closeTestConnections();
});

test("announcement_changed event shows and clears the banner live without refetching", async ({
  page,
  baseURL,
}) => {
  const db = getDb();
  const user = await createConfirmedUser(db);

  await loginAs(page.context(), user, baseURL!);
  const trpcCalls = recordTrpcProcedures(page);

  const sseResponse = page.waitForResponse((r) => r.url().includes("/api/v1/events"), {
    timeout: 90_000,
  });

  await page.goto("/all");
  await sseResponse;
  // The SSE handler subscribes to Redis channels asynchronously after the
  // response starts; wait until it's actually listening on the global channel.
  await waitForChannelSubscriber(getSiteStatusChannel());

  // Everything from here must happen via the SSE event, not a page reload.
  trpcCalls.length = 0;

  const message = "Known issue: feed refresh is delayed. We are on it.";
  await publishAnnouncementChanged({ id: "e2e-ann-1", message, level: "warning" });

  // Banner appears live.
  const banner = page.getByRole("status").filter({ hasText: message });
  await expect(banner).toBeVisible();

  // A live "cleared" event hides it again.
  await publishAnnouncementChanged(null);
  await expect(banner).toBeHidden();

  // The banner is not a query — its push must never trigger a data refetch.
  const refetches = trpcCalls.filter(
    (p) => p.startsWith("entries.") || p.startsWith("tags.") || p.startsWith("subscriptions.")
  );
  expect(refetches).toEqual([]);
});
