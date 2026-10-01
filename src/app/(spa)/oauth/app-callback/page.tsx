/**
 * The native app's OAuth redirect URL. The installed app claims it as an
 * Android App Link, so a browser only lands here when it didn't hand it over.
 */

import type { Metadata } from "next";
import { RELEASE_APP_PACKAGE } from "@/server/config/env";
import { AppCallbackContent } from "./AppCallbackContent";
import { OpenInApp } from "./OpenInApp";

// Keep the code-bearing URL out of the Referer of anything this page loads.
export const metadata: Metadata = { referrer: "no-referrer" };

export default function AppCallbackPage() {
  return (
    <AppCallbackContent>
      <OpenInApp packageName={RELEASE_APP_PACKAGE} label="Open Lion Reader" />
    </AppCallbackContent>
  );
}
