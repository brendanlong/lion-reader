/**
 * About section for the settings page
 *
 * Displays attribution and links in a card format.
 */

import { SettingsSection } from "@/components/settings/SettingsSection";

export function AboutSection() {
  return (
    <SettingsSection title="About">
      <p className="ui-text-sm text-zinc-600 dark:text-zinc-400">
        Lion Reader was created by{" "}
        <a
          href="https://www.brendanlong.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-zinc-900 hover:underline dark:text-zinc-50"
        >
          Brendan Long
        </a>{" "}
        and{" "}
        <a
          href="https://www.brendanlong.com/claude-wrote-me-a-400-commit-rss-reader-app.html"
          target="_blank"
          rel="noopener noreferrer"
          className="text-zinc-900 hover:underline dark:text-zinc-50"
        >
          Claude
        </a>
        .
      </p>
      <p className="ui-text-sm mt-2 text-zinc-600 dark:text-zinc-400">
        View the source code on{" "}
        <a
          href="https://github.com/brendanlong/lion-reader"
          target="_blank"
          rel="noopener noreferrer"
          className="text-zinc-900 hover:underline dark:text-zinc-50"
        >
          GitHub
        </a>
        .
      </p>
    </SettingsSection>
  );
}
