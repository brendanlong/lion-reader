/**
 * About section for the settings page: attribution, source, contact, and the
 * legal pages.
 */

import { SettingsSection } from "@/components/settings/SettingsSection";
import { PageLink } from "@/components/ui/page-link";
import { CONTACT_EMAIL } from "@/lib/contact";

export function AboutSection() {
  return (
    <SettingsSection id="about" title="About">
      <p className="ui-text-sm text-muted">
        Lion Reader was created by{" "}
        <a
          href="https://www.brendanlong.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-body hover:underline"
        >
          Brendan Long
        </a>{" "}
        and{" "}
        <a
          href="https://www.brendanlong.com/claude-wrote-me-a-400-commit-rss-reader-app.html"
          target="_blank"
          rel="noopener noreferrer"
          className="text-body hover:underline"
        >
          Claude
        </a>
        .
      </p>
      <p className="ui-text-sm text-muted mt-2">
        View the source code on{" "}
        <a
          href="https://github.com/brendanlong/lion-reader"
          target="_blank"
          rel="noopener noreferrer"
          className="text-body hover:underline"
        >
          GitHub
        </a>
        .
      </p>
      <p className="ui-text-sm text-muted mt-2">
        Questions or feedback? Email{" "}
        <a href={`mailto:${CONTACT_EMAIL}`} className="text-body hover:underline">
          {CONTACT_EMAIL}
        </a>
        .
      </p>
      <div className="mt-4 flex flex-wrap gap-x-6">
        <PageLink
          href="/privacy"
          className="ui-text-sm text-accent hover:text-accent-hover inline-flex min-h-11 items-center font-medium"
        >
          Privacy Policy
        </PageLink>
        <PageLink
          href="/terms"
          className="ui-text-sm text-accent hover:text-accent-hover inline-flex min-h-11 items-center font-medium"
        >
          Terms of Service
        </PageLink>
      </div>
    </SettingsSection>
  );
}
