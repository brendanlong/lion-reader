/**
 * Single Subscription Page
 *
 * Displays entries from a specific subscription.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";
import { SingleSubscriptionContent } from "./SingleSubscriptionContent";

interface SingleSubscriptionPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function SingleSubscriptionPage({
  params,
  searchParams,
}: SingleSubscriptionPageProps) {
  const { id: subscriptionId } = await params;

  return (
    <EntryListPage filters={{ subscriptionId }} searchParams={searchParams}>
      <SingleSubscriptionContent />
    </EntryListPage>
  );
}
