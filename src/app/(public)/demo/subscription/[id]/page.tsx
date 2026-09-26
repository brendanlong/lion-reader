/**
 * /demo/subscription/[id] — Subscription demo page
 *
 * Statically prerendered for each demo subscription (the ids are dev-authored
 * constants, enumerated via generateStaticParams).
 */

import { type Metadata } from "next";
import { pageMetadata } from "@/lib/metadata";
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
  return pageMetadata(
    `${subscription?.title ?? "Subscription"} - Lion Reader`,
    subscription?.description
  );
}

export default async function DemoSubscriptionPage({ params }: Props) {
  const { id } = await params;
  return <DemoApp location={{ pathname: `/subscription/${id}`, search: "" }} />;
}
