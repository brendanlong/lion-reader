/**
 * /demo/starred — the initially-starred demo articles
 */

import { type Metadata } from "next";
import { pageMetadata } from "@/lib/metadata";
import { DemoApp } from "../DemoApp";

export const metadata: Metadata = pageMetadata(
  "Starred - Lion Reader",
  "Starred articles in Lion Reader."
);

export default function Page() {
  return <DemoApp location={{ pathname: "/starred", search: "" }} />;
}
