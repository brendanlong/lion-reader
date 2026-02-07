/**
 * /demo → redirect to /demo/all?entry=welcome
 */

import { redirect } from "next/navigation";

export default function DemoIndexPage() {
  redirect("/demo/all?entry=welcome");
}
