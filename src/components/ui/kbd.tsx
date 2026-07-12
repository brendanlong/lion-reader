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
      className={`ui-text-xs bg-surface-muted text-body inline-flex min-w-[24px] items-center justify-center rounded border border-zinc-300 px-1.5 py-0.5 font-mono font-medium dark:border-zinc-600 ${className}`}
    >
      {children}
    </kbd>
  );
}
