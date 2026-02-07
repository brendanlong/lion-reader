/**
 * Landing Page
 *
 * Shows an interactive demo for unauthenticated users.
 * Authenticated users are redirected to /all.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { validateSession } from "@/server/auth/session";
import { DemoPage } from "./demo/DemoPage";

export default async function HomePage() {
  // Check if user is already authenticated
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("session")?.value;

  if (sessionToken) {
    const session = await validateSession(sessionToken);
    if (session) {
      // User is already signed in, redirect to the app
      redirect("/all");
    }
  }

  return <DemoPage />;
}
