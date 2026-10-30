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
import { toast } from "sonner";
import { buttonClassName } from "@/components/ui/button";

const CHIP_CLASSES =
  "ui-text-xs inline-flex items-center justify-center rounded border border-edge-input bg-surface-raised font-medium text-muted transition-colors hover:border-edge-emphasis hover:text-body hover-none:min-h-11 hover-none:min-w-11";

interface CopyButtonProps {
  /** Text to copy to the clipboard. */
  value: string;
  /**
   * `chip` (default) sits beside or on top of the value it copies; `button` is
   * a regular secondary Button, for a row of full-size buttons.
   */
  variant?: "chip" | "button";
  /** Extra classes for positioning, and for a chip its padding (e.g. "absolute top-2 right-2 px-2 py-1"). */
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
  variant = "chip",
  className = variant === "chip" ? "px-2 py-1" : "",
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

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch (error) {
      toast.error("Failed to copy", {
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={title}
      className={`${variant === "chip" ? CHIP_CLASSES : buttonClassName({ variant: "secondary" })} ${className}`}
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
      {/* On touch the copy button is 44px; keep a one-line block tall enough to hold it. */}
      <pre className="ui-text-xs border-edge-strong bg-surface-muted text-body hover-none:min-h-15 overflow-x-auto rounded-md border p-3 pr-20 font-mono">
        <code>{code}</code>
      </pre>
      <CopyButton value={code} className="absolute top-2 right-2 px-2 py-1" />
    </div>
  );
}
