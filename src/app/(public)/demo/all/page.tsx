/**
 * /demo/all — every demo article
 */

import { type Metadata } from "next";
import { pageMetadata } from "@/lib/metadata";
import { DemoApp } from "../DemoApp";

export const metadata: Metadata = pageMetadata(
  "All Items - Lion Reader",
  "Explore all of Lion Reader's features: feed support, reading experience, organization, and integrations."
);

export default function Page() {
  return <DemoApp location={{ pathname: "/all", search: "" }} />;
}
