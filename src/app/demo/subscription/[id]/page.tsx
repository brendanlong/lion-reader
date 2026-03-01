/**
 * /demo/subscription/[id] — Subscription demo page
 *
 * Server component that renders EntryArticle with static demo data when
 * ?entry= is present, or a static entry list with crawlable links when
 * no entry is selected. After hydration, DemoLayoutContent switches to
 * DemoRouter for full client-side interactivity.
 */

import { type Metadata } from "next";
import { EntryArticle } from "@/components/entries/EntryArticle";
import { defaultOpenGraph } from "@/lib/metadata";
import {
  getDemoEntry,
  getDemoEntryArticleProps,
  getDemoSubscription,
  getDemoEntriesForSubscription,
} from "../../data";
import { DemoEntryListSSR } from "../../DemoEntryListSSR";

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
  const title = entry?.title
    ? `${entry.title} - Lion Reader`
    : `${subscription?.title ?? "Subscription"} - Lion Reader`;
  const description = entry?.summary ?? subscription?.description;
  return {
    title,
    description,
    openGraph: { ...defaultOpenGraph, title, description },
    ...(entryId && { alternates: { canonical: `/demo/all?entry=${entryId}` } }),
  };
}

export default async function DemoSubscriptionPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const entryId = typeof sp.entry === "string" ? sp.entry : undefined;
  const entry = entryId ? getDemoEntry(entryId) : undefined;

  if (entry) {
    return <EntryArticle {...getDemoEntryArticleProps(entry)} />;
  }

  const subscription = getDemoSubscription(id);
  return (
    <DemoEntryListSSR
      entries={getDemoEntriesForSubscription(id)}
      backHref={`/demo/subscription/${id}`}
      title={subscription?.title ?? "Subscription"}
    />
  );
}
