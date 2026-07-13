/**
 * CopyButton / CodeBlock
 *
 * Small reusable "copy to clipboard" button (with transient "Copied!" feedback)
 * and a code block that pairs a <pre> with a copy button. Used across the
 * integrations settings sections (Google Reader API, Wallabag API, AI
 * Integrations, bookmarklet) so the copy affordance stays consistent.
 */

"use client";

import { useEffect, useRef, useState } from "react";

const BUTTON_CLASSES =
  "ui-text-xs rounded border border-edge-input bg-white font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600 dark:hover:text-zinc-100";

interface CopyButtonProps {
  /** Text to copy to the clipboard. */
  value: string;
  /** Extra classes for positioning/padding (e.g. "absolute top-2 right-2 px-2 py-1"). */
  className?: string;
  /** Label shown when idle. */
  label?: string;
  /** Label shown briefly after copying. */
  copiedLabel?: string;
  /** Accessible label when the button has no visible text alternative. */
  title?: string;
}

export function CopyButton({
  value,
  className = "px-2 py-1",
  label = "Copy",
  copiedLabel = "Copied!",
  title,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = () => {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={title}
      className={`${BUTTON_CLASSES} ${className}`}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}

interface CodeBlockProps {
  /** Code/text to display and copy. */
  code: string;
  /** Extra classes for the wrapping element. */
  className?: string;
}

export function CodeBlock({ code, className = "" }: CodeBlockProps) {
  return (
    <div className={`relative ${className}`}>
      <pre className="ui-text-xs border-edge-strong bg-surface-muted text-emphasis overflow-x-auto rounded-md border p-3 pr-20 font-mono">
        <code>{code}</code>
      </pre>
      <CopyButton value={code} className="absolute top-2 right-2 px-2 py-1" />
    </div>
  );
}
