/**
 * Landing Page
 *
 * Redirects authenticated users to /all and unauthenticated users to the demo.
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
