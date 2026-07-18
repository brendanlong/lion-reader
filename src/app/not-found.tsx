/**
 * Root 404 Page
 *
 * Next's built-in not-found page is unthemed (white background, default
 * fonts), which reads as a jarring white flash for dark-mode users when they
 * hit a dead link (issue #1350). This renders inside the root layout, so the
 * blocking theme script and globals.css apply and the page matches the app's
 * canvas in every theme.
 */

import type { Metadata } from "next";
import { PageLink } from "@/components/ui/page-link";

export const metadata: Metadata = {
  title: "Page Not Found - Lion Reader",
};

export default function NotFound() {
  return (
    <div className="bg-canvas flex min-h-screen flex-col items-center justify-center px-4 py-12 text-center">
      <h1 className="ui-text-2xl text-body font-bold">Page not found</h1>
      <p className="ui-text-sm text-muted mt-2">
        The page you&apos;re looking for doesn&apos;t exist or may have moved.
      </p>
      <PageLink
        href="/"
        className="btn-primary ui-text-sm mt-6 inline-flex min-h-[40px] items-center rounded-md px-4 font-medium"
      >
        Back to Lion Reader
      </PageLink>
    </div>
  );
}
