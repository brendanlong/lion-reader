/**
 * /demo/uncategorized — demo articles from untagged subscriptions
 */

import { type Metadata } from "next";
import { pageMetadata } from "@/lib/metadata";
import { DemoApp } from "../DemoApp";

export const metadata: Metadata = pageMetadata(
  "Uncategorized - Lion Reader",
  "Articles from untagged feeds in Lion Reader."
);

export default function Page() {
  return <DemoApp location={{ pathname: "/uncategorized", search: "" }} />;
}
