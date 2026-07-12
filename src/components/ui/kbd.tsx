/**
 * Kbd Component
 *
 * Keyboard key chip for displaying shortcut keys.
 */

import type { ReactNode } from "react";

export interface KbdProps {
  children: ReactNode;
  className?: string;
}

export function Kbd({ children, className = "" }: KbdProps) {
  return (
    <kbd
      className={`ui-text-xs inline-flex min-w-[24px] items-center justify-center rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 font-mono font-medium text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 ${className}`}
    >
      {children}
    </kbd>
  );
}
