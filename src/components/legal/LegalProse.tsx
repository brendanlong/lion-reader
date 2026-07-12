/**
 * LegalProse Components
 *
 * Shared building blocks for the public legal pages (privacy policy, terms
 * of service): the page scaffold and the prose styles for sections,
 * subsections, paragraphs, and lists. Use these instead of hand-styling
 * each element so the two pages can't drift apart.
 *
 * These pages intentionally use Next.js <Link> (not ClientLink) — they are
 * standalone routes outside the SPA shell.
 */

import Link from "next/link";
import type { ReactNode } from "react";

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
    <div className="min-h-screen bg-zinc-50 px-4 py-12 dark:bg-zinc-950">
      <main className="mx-auto max-w-3xl">
        <div className="mb-8">
          <Link
            href="/"
            className="ui-text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            &larr; Back to Lion Reader
          </Link>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            {title}
          </h1>
          <p className="ui-text-sm mt-2 text-zinc-500 dark:text-zinc-400">
            Last updated: {lastUpdated}
          </p>
        </div>

        <div className="prose prose-zinc dark:prose-invert max-w-none">{children}</div>
      </main>
    </div>
  );
}

/**
 * Top-level section with the standard heading.
 */
export interface LegalSectionProps {
  title: string;
  children: ReactNode;
}

export function LegalSection({ title, children }: LegalSectionProps) {
  return (
    <section className="mb-8">
      <h2 className="ui-text-xl font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Titled subsection within a section (h3 + body).
 */
export interface LegalSubsectionProps {
  title: string;
  children: ReactNode;
}

export function LegalSubsection({ title, children }: LegalSubsectionProps) {
  return (
    <div>
      <h3 className="font-medium text-zinc-800 dark:text-zinc-200">{title}</h3>
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
  return (
    <p className={`${tight ? "mt-1" : "mt-2"} text-zinc-600 dark:text-zinc-400`}>{children}</p>
  );
}

/**
 * Bulleted list.
 */
export interface LegalListProps {
  children: ReactNode;
}

export function LegalList({ children }: LegalListProps) {
  return (
    <ul className="mt-2 list-disc space-y-1 pl-6 text-zinc-600 dark:text-zinc-400">{children}</ul>
  );
}
