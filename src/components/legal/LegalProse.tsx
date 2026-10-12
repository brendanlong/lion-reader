/**
 * LegalProse Components
 *
 * Shared building blocks for the public legal pages (privacy policy, terms
 * of service): the page scaffold and the prose styles for sections,
 * subsections, paragraphs, and lists. Use these instead of hand-styling
 * each element so the two pages can't drift apart.
 *
 * These pages intentionally navigate with <PageLink> (a plain full-page <a>),
 * not ClientLink — they are standalone routes outside the SPA shell, loaded
 * with a full navigation rather than a Next.js RSC prefetch/soft-nav.
 */

import type { ReactNode } from "react";
import { PageLink } from "@/components/ui/page-link";

/**
 * Full legal-page scaffold: background, centered column, back link,
 * page title, and "Last updated" line, wrapping the prose content.
 */
export interface LegalPageProps {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}

export function LegalPage({ title, lastUpdated, children }: LegalPageProps) {
  return (
    <div className="bg-canvas min-h-screen px-4 py-12">
      <main className="mx-auto max-w-3xl">
        <div className="mb-8">
          <PageLink href="/" className="ui-text-sm text-muted hover:text-body">
            &larr; Back to Lion Reader
          </PageLink>
          <h1 className="text-body mt-4 text-3xl font-bold tracking-tight">{title}</h1>
          <p className="ui-text-sm text-muted mt-2">Last updated: {lastUpdated}</p>
        </div>

        <div className="prose prose-zinc dark:prose-invert max-w-none">{children}</div>
      </main>
    </div>
  );
}

/**
 * Heading text that links to its own anchor, so readers can copy a link
 * to any section. The `id` is spelled out rather than derived from the
 * title so editing a title (e.g. its provider list) doesn't break links.
 */
function HeadingSelfLink({ id, title }: { id: string; title: string }) {
  return (
    <a href={`#${id}`} className="group text-inherit no-underline">
      {title}
      <span
        aria-hidden="true"
        className="text-muted ml-2 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        #
      </span>
    </a>
  );
}

/**
 * Top-level section with the standard heading.
 */
export interface LegalSectionProps {
  id: string;
  title: string;
  children: ReactNode;
}

export function LegalSection({ id, title, children }: LegalSectionProps) {
  return (
    <section className="mb-8">
      <h2 id={id} className="ui-text-xl text-body scroll-mt-4 font-semibold">
        <HeadingSelfLink id={id} title={title} />
      </h2>
      {children}
    </section>
  );
}

/**
 * Titled subsection within a section (h3 + body).
 */
export interface LegalSubsectionProps {
  id: string;
  title: string;
  children: ReactNode;
}

export function LegalSubsection({ id, title, children }: LegalSubsectionProps) {
  return (
    <div>
      <h3 id={id} className="text-body scroll-mt-4 font-medium">
        <HeadingSelfLink id={id} title={title} />
      </h3>
      {children}
    </div>
  );
}

/**
 * Body paragraph. `tight` uses the smaller top margin for paragraphs
 * directly under a subsection heading.
 */
export interface LegalParagraphProps {
  children: ReactNode;
  tight?: boolean;
}

export function LegalParagraph({ children, tight = false }: LegalParagraphProps) {
  return <p className={`${tight ? "mt-1" : "mt-2"} text-muted`}>{children}</p>;
}

/**
 * Bulleted list.
 */
export interface LegalListProps {
  children: ReactNode;
}

export function LegalList({ children }: LegalListProps) {
  return <ul className="text-muted mt-2 list-disc space-y-1 pl-6">{children}</ul>;
}
