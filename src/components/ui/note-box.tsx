/**
 * NoteBox Component
 *
 * Subtle zinc-tinted box for notes, hints, and secondary content inside
 * cards (e.g. "how to use" notes, linked-account rows). Use instead of
 * copying the rounded-md zinc-50 box classes.
 */

import type { ReactNode } from "react";

export interface NoteBoxProps {
  children: ReactNode;
  /** Padding size */
  padding?: "sm" | "md";
  /** Additional class name */
  className?: string;
}

export function NoteBox({ children, padding = "md", className = "" }: NoteBoxProps) {
  const paddingStyles = {
    sm: "px-3 py-2",
    md: "p-4",
  };

  return (
    <div
      className={`border-edge-strong bg-surface-subtle rounded-md border ${paddingStyles[padding]} ${className}`}
    >
      {children}
    </div>
  );
}
