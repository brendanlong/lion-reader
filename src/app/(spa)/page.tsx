/**
 * Landing Page
 *
 * Redirects authenticated users to /all and unauthenticated users to the demo.
 *
 * Normally unreachable: `maybeSessionRedirect` in src/proxy.ts answers `/`
 * before Next renders (anonymous → demo without a render; validated session →
 * /all). This page is the fallback for the proxy's validation-error
 * fall-through — keep its logic in sync with the proxy's.
 */

import { redirect } from "next/navigation";
import { getRequestSession } from "@/server/auth/request-session";
import { sessionHomePath } from "@/server/auth/confirmation";
import { DEMO_LANDING_PATH } from "@/lib/routes";

export default async function HomePage() {
  const current = await getRequestSession();
  if (current) {
    redirect(sessionHomePath(current.session.user));
  }

  redirect(DEMO_LANDING_PATH);
}
