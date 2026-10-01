/**
 * The debug app's OAuth redirect URL (see `src/server/oauth/app-client.ts`). A
 * dev server on this machine is plain http, which can't be an App Link, so
 * there the button goes through the debug build's dev-only intent filter.
 */

import type { Metadata } from "next";
import { DEBUG_APP_PACKAGE } from "@/server/config/env";
import { getIssuer } from "@/server/oauth/config";
import { isLoopbackUrl } from "@/server/oauth/utils";
import { AppCallbackContent } from "../AppCallbackContent";
import { OpenInApp } from "../OpenInApp";

export const metadata: Metadata = { referrer: "no-referrer" };

export default function DebugAppCallbackPage() {
  return (
    <AppCallbackContent>
      <OpenInApp
        packageName={DEBUG_APP_PACKAGE}
        action={
          isLoopbackUrl(getIssuer()) ? "com.lionreader.app.DEBUG_SIGN_IN_CALLBACK" : undefined
        }
        label="Open the debug app"
      />
    </AppCallbackContent>
  );
}
