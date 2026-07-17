/**
 * Footer component for auth pages (login/register)
 *
 * Displays attribution, legal links, and GitHub link in a compact format.
 */

import { PageLink } from "@/components/ui/page-link";

export function AuthFooter() {
  return (
    <footer className="border-edge mt-8 border-t pt-6">
      <p className="ui-text-xs text-muted text-center">
        <PageLink href="/terms" className="hover:text-body hover:underline">
          Terms of Service
        </PageLink>{" "}
        •{" "}
        <PageLink href="/privacy" className="hover:text-body hover:underline">
          Privacy Policy
        </PageLink>
      </p>
      <p className="ui-text-xs text-muted mt-2 text-center">
        Created by{" "}
        <a
          href="https://www.brendanlong.com"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-body hover:underline"
        >
          Brendan Long
        </a>{" "}
        and{" "}
        <a
          href="https://www.brendanlong.com/claude-wrote-me-a-400-commit-rss-reader-app.html"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-body hover:underline"
        >
          Claude
        </a>{" "}
        •{" "}
        <a
          href="https://github.com/brendanlong/lion-reader"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-body hover:underline"
        >
          View on GitHub
        </a>
      </p>
    </footer>
  );
}
