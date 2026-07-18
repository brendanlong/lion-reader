/**
 * /demo → redirect to the demo landing page (shared constant with the proxy's
 * `/` fast path and the `/` fallback page).
 */

import { redirect } from "next/navigation";
import { DEMO_LANDING_PATH } from "@/lib/routes";

export default function DemoIndexPage() {
  redirect(DEMO_LANDING_PATH);
}
