/**
 * /demo/saved — the demo articles saved for later
 */

import { type Metadata } from "next";
import { pageMetadata } from "@/lib/metadata";
import { DemoApp } from "../DemoApp";

export const metadata: Metadata = pageMetadata(
  "Saved - Lion Reader",
  "Articles saved for later in Lion Reader."
);

export default function Page() {
  return <DemoApp location={{ pathname: "/saved", search: "" }} />;
}
