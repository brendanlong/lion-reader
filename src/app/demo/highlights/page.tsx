/**
 * /demo/highlights — Highlights demo page
 *
 * Route stub; content rendered by DemoRouter in the parent layout.
 */

import { type Metadata } from "next";
import { getDemoEntry } from "../data";

interface Props {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const sp = await searchParams;
  const entryId = typeof sp.entry === "string" ? sp.entry : undefined;
  const entry = entryId ? getDemoEntry(entryId) : undefined;
  return {
    title: entry?.title ? `${entry.title} - Lion Reader Demo` : "Highlights - Lion Reader Demo",
  };
}

export default function DemoHighlightsPage() {
  return null;
}
