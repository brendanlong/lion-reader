/**
 * InlineCode Component
 *
 * Small monospace chip for inline code, URLs, file names, and custom emoji
 * text. Use instead of copying the mono-chip classes onto raw <code> tags.
 */

import type { HTMLAttributes } from "react";

export interface InlineCodeProps extends HTMLAttributes<HTMLElement> {
  className?: string;
}

export function InlineCode({ className = "", children, ...props }: InlineCodeProps) {
  return (
    <code
      className={`ui-text-xs rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800 ${className}`}
      {...props}
    >
      {children}
    </code>
  );
}
