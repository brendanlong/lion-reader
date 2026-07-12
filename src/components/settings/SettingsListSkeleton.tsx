/**
 * Shared loading skeleton for settings list pages.
 *
 * Two variants match the two card patterns used across settings pages:
 * - "interior" (default): Skeleton rows inside a card, with p-6 padding
 * - "card": Standalone bordered cards with spacing between them
 */

interface SettingsListSkeletonProps {
  count?: number;
  height?: string;
  variant?: "interior" | "card";
}

export function SettingsListSkeleton({
  count = 3,
  height = "h-24",
  variant = "interior",
}: SettingsListSkeletonProps) {
  const items = Array.from({ length: count }, (_, i) => i);

  if (variant === "card") {
    return (
      <>
        {items.map((i) => (
          <div
            key={i}
            className={`${height} border-edge bg-surface animate-pulse rounded-lg border`}
          />
        ))}
      </>
    );
  }

  return (
    <div className="p-6">
      {items.map((i) => (
        <div
          key={i}
          className={`mb-4 ${height} bg-surface-muted animate-pulse rounded last:mb-0`}
        />
      ))}
    </div>
  );
}
