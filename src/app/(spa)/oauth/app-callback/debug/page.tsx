/**
 * The debug app's OAuth redirect URL (see `src/server/oauth/app-client.ts`). On
 * a dev server on this machine the redirect is plain http, which can't be an
 * App Link, so it always lands here; a button hands it to the debug app.
 */

import type { Metadata } from "next";
import { getIssuer } from "@/server/oauth/config";
import { isLoopbackUrl } from "@/server/oauth/utils";
import { AppCallbackContent } from "../AppCallbackContent";
import { OpenInDebugApp } from "./OpenInDebugApp";

export const metadata: Metadata = { referrer: "no-referrer" };

export default function DebugAppCallbackPage() {
  return (
    <AppCallbackContent>{isLoopbackUrl(getIssuer()) && <OpenInDebugApp />}</AppCallbackContent>
  );
}
