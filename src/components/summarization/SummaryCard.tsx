/**
 * SummaryCard Component
 *
 * Displays an AI-generated summary in a collapsible card.
 * Shown at the top of entry content when a summary is available.
 */

"use client";

import { useState } from "react";

import { useEntryTextStyles } from "@/lib/appearance";

/**
 * Sparkles icon for AI indicator.
 */
function SparklesIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"
      />
    </svg>
  );
}

/**
 * Chevron down icon.
 */
function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

/**
 * Chevron up icon.
 */
function ChevronUpIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
    </svg>
  );
}

/**
 * Format a date for display.
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Props for the SummaryCard component.
 */
export interface SummaryCardProps {
  /** The summary HTML to display (already converted from Markdown on server) */
  summary: string | null;
  /** The model ID used for generation */
  modelId: string | null;
  /** When the summary was generated (null if not yet generated) */
  generatedAt: Date | null;
  /** Whether the summary is currently being generated */
  isLoading?: boolean;
  /** Error message if generation failed */
  error?: string | null;
  /** Callback when regenerate button is clicked */
  onRegenerate?: () => void;
  /** Callback when close button is clicked */
  onClose?: () => void;
}

/**
 * SummaryCard displays an AI-generated summary in a collapsible card.
 */
export function SummaryCard({
  summary,
  modelId,
  generatedAt,
  isLoading = false,
  error = null,
  onRegenerate,
  onClose,
}: SummaryCardProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { style } = useEntryTextStyles();

  // Show loading state
  if (isLoading) {
    return (
      <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
        <div className="flex items-center gap-3">
          <SparklesIcon className="h-5 w-5 animate-pulse text-blue-600 dark:text-blue-400" />
          <span className="ui-text-sm font-medium text-blue-900 dark:text-blue-100">
            Generating summary...
          </span>
          <svg
            className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        </div>
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-900/20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SparklesIcon className="h-5 w-5 text-red-600 dark:text-red-400" />
            <span className="ui-text-sm font-medium text-red-900 dark:text-red-100">
              Summary generation failed
            </span>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="rounded p-1 text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-800/50"
              aria-label="Close"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>
        <p className="ui-text-sm mt-2 text-red-700 dark:text-red-300">{error}</p>
        {onRegenerate && (
          <button
            onClick={onRegenerate}
            className="ui-text-sm mt-3 font-medium text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  // Show summary
  return (
    <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SparklesIcon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          <span className="ui-text-sm font-medium text-blue-900 dark:text-blue-100">
            AI Summary
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onClose && (
            <button
              onClick={onClose}
              className="rounded p-1 text-blue-600 hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-800/50"
              aria-label="Close summary"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="rounded p-1 text-blue-600 hover:bg-blue-100 dark:text-blue-400 dark:hover:bg-blue-800/50"
            aria-label={isCollapsed ? "Expand summary" : "Collapse summary"}
          >
            {isCollapsed ? (
              <ChevronDownIcon className="h-4 w-4" />
            ) : (
              <ChevronUpIcon className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <>
          <div
            className="prose prose-blue dark:prose-invert mt-3 max-w-none text-blue-900 dark:text-blue-100 [&_a]:text-blue-700 dark:[&_a]:text-blue-300 [&_li]:my-0 [&_ol]:my-1 [&_ul]:my-1"
            style={style}
            dangerouslySetInnerHTML={{ __html: summary ?? "No content." }}
          />

          {/* Footer */}
          <div className="ui-text-xs mt-3 flex items-center justify-between text-blue-600 dark:text-blue-400">
            <span>
              Generated by {modelId?.replace("claude-", "Claude ")?.replace(/-/g, " ") ?? "Unknown"}
              {generatedAt && ` on ${formatDate(generatedAt)}`}
            </span>
            {onRegenerate && (
              <button
                onClick={onRegenerate}
                className="font-medium hover:text-blue-700 dark:hover:text-blue-300"
              >
                Regenerate
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
