/**
 * SettingsSection Component
 *
 * A reusable wrapper for settings sections that provides consistent styling.
 * Handles loading, error, and success states with standard patterns.
 */

import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import type { ReactNode } from "react";

// ============================================================================
// Types
// ============================================================================

interface SettingsSectionProps {
  /**
   * The title displayed as the section heading.
   */
  title: string;

  /**
   * The main content of the section.
   */
  children: ReactNode;

  /**
   * Optional description shown below the title inside the card.
   */
  description?: ReactNode;

  /**
   * Whether the section is loading. Shows skeleton UI when true.
   */
  isLoading?: boolean;

  /**
   * Error message to display. Shows error alert when provided.
   */
  error?: string | null;

  /**
   * Success message to display. Shows success alert when provided.
   */
  success?: string | null;

  /**
   * Number of skeleton rows to show when loading. Defaults to 2.
   */
  skeletonRows?: number;
}

// ============================================================================
// SettingsSection Component
// ============================================================================

export function SettingsSection({
  title,
  children,
  description,
  isLoading,
  error,
  success,
  skeletonRows = 2,
}: SettingsSectionProps) {
  if (isLoading) {
    return (
      <section>
        <SettingsSectionHeading>{title}</SettingsSectionHeading>
        <Card>
          <div className="space-y-4">
            {Array.from({ length: skeletonRows }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            ))}
          </div>
        </Card>
      </section>
    );
  }

  return (
    <section>
      <SettingsSectionHeading>{title}</SettingsSectionHeading>
      <Card>
        {description && (
          <p className="ui-text-sm mb-4 text-zinc-500 dark:text-zinc-400">{description}</p>
        )}

        {error && (
          <Alert variant="error" className="mb-4">
            {error}
          </Alert>
        )}

        {success && (
          <Alert variant="success" className="mb-4">
            {success}
          </Alert>
        )}

        {children}
      </Card>
    </section>
  );
}

/**
 * The standard settings section heading. Exported for sections whose card
 * content doesn't fit the SettingsSection wrapper.
 */
export function SettingsSectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">{children}</h2>
  );
}
