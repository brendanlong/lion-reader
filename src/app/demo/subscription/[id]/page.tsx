/**
 * /demo/subscription/[id] — Subscription demo page
 *
 * Route stub with dynamic metadata; content rendered by DemoRouter in the parent layout.
 */

import { type Metadata } from "next";
import { getDemoEntry, getDemoSubscription } from "../../data";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { id } = await params;
  const sp = await searchParams;
  const entryId = typeof sp.entry === "string" ? sp.entry : undefined;
  const entry = entryId ? getDemoEntry(entryId) : undefined;
  const subscription = getDemoSubscription(id);
  return {
    title: entry?.title
      ? `${entry.title} - Lion Reader Demo`
      : `${subscription?.title ?? "Subscription"} - Lion Reader Demo`,
  };
}

export default function DemoSubscriptionPage() {
  return null;
}
