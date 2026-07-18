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

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { validateSession } from "@/server/auth/session";

export default async function HomePage() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("session")?.value;

  if (sessionToken) {
    const session = await validateSession(sessionToken);
    if (session) {
      redirect("/all");
    }
  }

  redirect("/demo/all?entry=welcome");
}
