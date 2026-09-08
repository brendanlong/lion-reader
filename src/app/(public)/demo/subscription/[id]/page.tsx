/**
 * /demo/subscription/[id] — Subscription demo page
 *
 * Statically prerendered for each demo subscription (the ids are dev-authored
 * constants, enumerated via generateStaticParams). Article views (`?entry=`)
 * never reach this page: the `beforeFiles` rewrite in next.config.ts serves
 * them from the prerendered /demo/entry/[entryId] route instead (issue #1359)
 * — do NOT read `searchParams` here, that would force per-request rendering.
 */

import { type Metadata } from "next";
import { pageOpenGraph } from "@/lib/metadata";
import { DEMO_SUBSCRIPTIONS, getDemoSubscription } from "../../data";
import { DemoApp } from "../../DemoApp";

// Unknown ids 404 instead of being rendered (and cached) on demand.
export const dynamicParams = false;

export function generateStaticParams() {
  return DEMO_SUBSCRIPTIONS.map((sub) => ({ id: sub.id }));
}

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const subscription = getDemoSubscription(id);
  const title = `${subscription?.title ?? "Subscription"} - Lion Reader`;
  const description = subscription?.description;
  return {
    title,
    description,
    openGraph: pageOpenGraph(title, description),
  };
}

export default async function DemoSubscriptionPage({ params }: Props) {
  const { id } = await params;
  return <DemoApp location={{ pathname: `/subscription/${id}`, search: "" }} />;
}
