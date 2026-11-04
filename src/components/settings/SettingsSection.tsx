/**
 * SettingsSection Component
 *
 * A reusable wrapper for settings sections that provides consistent styling.
 * Handles loading and load-error states with standard patterns.
 */

import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import type { ReactNode } from "react";
import type { SettingsSectionId } from "./settings-search";

// ============================================================================
// Types
// ============================================================================

interface SettingsSectionProps {
  /**
   * The section's settings-search id, also its element id, so
   * `/settings/<page>#<id>` links straight to it.
   */
  id: SettingsSectionId;

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
   * Number of skeleton rows to show when loading. Defaults to 2.
   */
  skeletonRows?: number;
}

// ============================================================================
// SettingsSection Component
// ============================================================================

export function SettingsSection({
  id,
  title,
  children,
  description,
  isLoading,
  error,
  skeletonRows = 2,
}: SettingsSectionProps) {
  if (isLoading) {
    return (
      <section id={id}>
        <SettingsSectionHeading>{title}</SettingsSectionHeading>
        <Card>
          <div className="space-y-4">
            {Array.from({ length: skeletonRows }).map((_, i) => (
              <div key={i} className="bg-fill-muted h-10 animate-pulse rounded" />
            ))}
          </div>
        </Card>
      </section>
    );
  }

  return (
    <section id={id}>
      <SettingsSectionHeading>{title}</SettingsSectionHeading>
      <Card>
        {description && <p className="ui-text-sm text-muted mb-4">{description}</p>}

        {error && (
          <Alert variant="error" className="mb-4">
            {error}
          </Alert>
        )}

        {children}
      </Card>
    </section>
  );
}

function SettingsSectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="ui-text-lg text-body mb-4 font-semibold">{children}</h2>;
}
