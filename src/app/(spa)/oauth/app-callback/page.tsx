/**
 * The native app's OAuth redirect URL. The installed app claims it as an
 * Android App Link, so a browser only lands here when it doesn't.
 */

import type { Metadata } from "next";
import { AppCallbackContent } from "./AppCallbackContent";

// Keep the code-bearing URL out of the Referer of anything this page loads.
export const metadata: Metadata = { referrer: "no-referrer" };

export default function AppCallbackPage() {
  return <AppCallbackContent />;
}
