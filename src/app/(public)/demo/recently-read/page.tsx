/**
 * /demo/recently-read — demo articles in the order they were read
 */

import { type Metadata } from "next";
import { pageMetadata } from "@/lib/metadata";
import { DemoApp } from "../DemoApp";

export const metadata: Metadata = pageMetadata(
  "Recently Read - Lion Reader",
  "Articles you have recently read in Lion Reader."
);

export default function Page() {
  return <DemoApp location={{ pathname: "/recently-read", search: "" }} />;
}
