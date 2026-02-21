/**
 * Single Subscription Page
 *
 * Prefetches entry data for /subscription/[id] route. AppRouter handles rendering.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";

interface SingleSubscriptionPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function SingleSubscriptionPage({
  params,
  searchParams,
}: SingleSubscriptionPageProps) {
  const { id: subscriptionId } = await params;

  return <EntryListPage filters={{ subscriptionId }} searchParams={searchParams} />;
}
