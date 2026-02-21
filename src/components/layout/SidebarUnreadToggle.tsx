/**
 * SidebarUnreadToggle Component
 *
 * A small toggle button for the sidebar that switches between showing
 * all tags/subscriptions or only those with unread entries.
 */

"use client";

/**
 * Eye icon (showing all) - local component because it needs suppressHydrationWarning
 * on the SVG element since the toggle state comes from localStorage.
 */
function EyeIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      suppressHydrationWarning
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
      />
    </svg>
  );
}

/**
 * Eye-slash icon (unread only) - local component because it needs suppressHydrationWarning
 * on the SVG element since the toggle state comes from localStorage.
 */
function EyeSlashIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      suppressHydrationWarning
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
      />
    </svg>
  );
}

interface SidebarUnreadToggleProps {
  unreadOnly: boolean;
  onToggle: () => void;
}

export function SidebarUnreadToggle({ unreadOnly, onToggle }: SidebarUnreadToggleProps) {
  const label = unreadOnly ? "Show all feeds" : "Show unread only";

  return (
    <button
      type="button"
      onClick={onToggle}
      className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
      title={label}
      aria-label={label}
      aria-pressed={unreadOnly}
      suppressHydrationWarning
    >
      {unreadOnly ? <EyeSlashIcon /> : <EyeIcon />}
    </button>
  );
}
