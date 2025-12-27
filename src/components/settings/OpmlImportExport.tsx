/**
 * OPML Import/Export Component
 *
 * Provides UI for importing feeds from OPML files and exporting subscriptions.
 * Features:
 * - File upload with drag-and-drop support
 * - Preview of feeds to import
 * - Import progress and results display
 * - Export download functionality
 */

"use client";

import { useState, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc/client";
import { Button, Alert } from "@/components/ui";
import { parseOpml, type OpmlFeed } from "@/server/feed/opml";

// ============================================================================
// Types
// ============================================================================

interface ImportResult {
  url: string;
  title: string | null;
  status: "imported" | "skipped" | "failed";
  error?: string;
}

type ImportState =
  | { type: "idle" }
  | { type: "parsing" }
  | { type: "preview"; feeds: OpmlFeed[]; opmlContent: string }
  | { type: "importing" }
  | {
      type: "complete";
      imported: number;
      skipped: number;
      failed: number;
      results: ImportResult[];
    };

// ============================================================================
// OpmlImportExport Component
// ============================================================================

export function OpmlImportExport() {
  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
        Import / Export
      </h2>
      <div className="space-y-6">
        <ImportSection />
        <ExportSection />
      </div>
    </section>
  );
}

// ============================================================================
// Import Section
// ============================================================================

function ImportSection() {
  const [importState, setImportState] = useState<ImportState>({ type: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const utils = trpc.useUtils();

  const importMutation = trpc.subscriptions.import.useMutation({
    onSuccess: (data) => {
      setImportState({
        type: "complete",
        imported: data.imported,
        skipped: data.skipped,
        failed: data.failed,
        results: data.results,
      });
      // Invalidate subscriptions cache to refresh the sidebar
      utils.subscriptions.list.invalidate();
    },
    onError: (err) => {
      setError(err.message || "Failed to import feeds");
      setImportState({ type: "idle" });
    },
  });

  const handleFileSelect = useCallback(async (file: File) => {
    setError(null);
    setImportState({ type: "parsing" });

    // Validate file type
    if (!file.name.endsWith(".opml") && !file.name.endsWith(".xml")) {
      setError("Please select an OPML or XML file");
      setImportState({ type: "idle" });
      return;
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      setError("File is too large (max 5MB)");
      setImportState({ type: "idle" });
      return;
    }

    try {
      const content = await file.text();
      const feeds = parseOpml(content);

      if (feeds.length === 0) {
        setError("No feeds found in the OPML file");
        setImportState({ type: "idle" });
        return;
      }

      setImportState({ type: "preview", feeds, opmlContent: content });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse OPML file");
      setImportState({ type: "idle" });
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      const file = e.dataTransfer.files[0];
      if (file) {
        handleFileSelect(file);
      }
    },
    [handleFileSelect]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleFileSelect(file);
      }
    },
    [handleFileSelect]
  );

  const handleImport = useCallback(() => {
    if (importState.type !== "preview") return;

    setImportState({ type: "importing" });
    importMutation.mutate({ opml: importState.opmlContent });
  }, [importState, importMutation]);

  const handleReset = useCallback(() => {
    setImportState({ type: "idle" });
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-50">Import from OPML</h3>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Import your feed subscriptions from another RSS reader by uploading an OPML file.
      </p>

      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      {importState.type === "idle" && (
        <div
          className={`relative rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
            isDragOver
              ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/20"
              : "border-zinc-300 dark:border-zinc-700"
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".opml,.xml"
            onChange={handleInputChange}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
          <div className="pointer-events-none">
            <svg
              className="mx-auto h-12 w-12 text-zinc-400 dark:text-zinc-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              Drag and drop your OPML file here, or{" "}
              <span className="font-medium text-blue-600 dark:text-blue-400">browse</span>
            </p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
              Supports .opml and .xml files up to 5MB
            </p>
          </div>
        </div>
      )}

      {importState.type === "parsing" && (
        <div className="flex items-center justify-center py-8">
          <svg className="h-6 w-6 animate-spin text-zinc-400" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
              fill="none"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span className="ml-2 text-sm text-zinc-600 dark:text-zinc-400">
            Parsing OPML file...
          </span>
        </div>
      )}

      {importState.type === "preview" && (
        <ImportPreview
          feeds={importState.feeds}
          onImport={handleImport}
          onCancel={handleReset}
          isImporting={false}
        />
      )}

      {importState.type === "importing" && (
        <div className="py-4">
          <div className="mb-2 flex items-center">
            <svg className="h-5 w-5 animate-spin text-blue-500" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span className="ml-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Importing feeds...
            </span>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            This may take a moment depending on the number of feeds.
          </p>
        </div>
      )}

      {importState.type === "complete" && (
        <ImportResults
          imported={importState.imported}
          skipped={importState.skipped}
          failed={importState.failed}
          results={importState.results}
          onReset={handleReset}
        />
      )}
    </div>
  );
}

// ============================================================================
// Import Preview Component
// ============================================================================

interface ImportPreviewProps {
  feeds: OpmlFeed[];
  onImport: () => void;
  onCancel: () => void;
  isImporting: boolean;
}

function ImportPreview({ feeds, onImport, onCancel, isImporting }: ImportPreviewProps) {
  const [showAll, setShowAll] = useState(false);
  const displayedFeeds = showAll ? feeds : feeds.slice(0, 10);
  const hasMore = feeds.length > 10;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Found {feeds.length} feed{feeds.length !== 1 ? "s" : ""} to import
        </p>
      </div>

      <div className="mb-4 max-h-64 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-700">
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-700">
          {displayedFeeds.map((feed, index) => (
            <li key={`${feed.xmlUrl}-${index}`} className="px-4 py-3">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                {feed.title || "Untitled Feed"}
              </p>
              <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">
                {feed.xmlUrl}
              </p>
              {feed.category && feed.category.length > 0 && (
                <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                  Folder: {feed.category.join(" / ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>

      {hasMore && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mb-4 text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          Show all {feeds.length} feeds
        </button>
      )}

      <div className="flex gap-3">
        <Button onClick={onImport} loading={isImporting}>
          Import {feeds.length} feed{feeds.length !== 1 ? "s" : ""}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={isImporting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Import Results Component
// ============================================================================

interface ImportResultsProps {
  imported: number;
  skipped: number;
  failed: number;
  results: ImportResult[];
  onReset: () => void;
}

function ImportResults({ imported, skipped, failed, results, onReset }: ImportResultsProps) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div>
      <Alert variant={failed > 0 ? "warning" : "success"} className="mb-4">
        Import complete: {imported} imported, {skipped} skipped, {failed} failed
      </Alert>

      <div className="mb-4 grid grid-cols-3 gap-4">
        <div className="rounded-md bg-green-50 p-3 dark:bg-green-950/20">
          <p className="text-2xl font-bold text-green-600 dark:text-green-400">{imported}</p>
          <p className="text-xs text-green-600 dark:text-green-400">Imported</p>
        </div>
        <div className="rounded-md bg-yellow-50 p-3 dark:bg-yellow-950/20">
          <p className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">{skipped}</p>
          <p className="text-xs text-yellow-600 dark:text-yellow-400">Skipped</p>
        </div>
        <div className="rounded-md bg-red-50 p-3 dark:bg-red-950/20">
          <p className="text-2xl font-bold text-red-600 dark:text-red-400">{failed}</p>
          <p className="text-xs text-red-600 dark:text-red-400">Failed</p>
        </div>
      </div>

      {results.length > 0 && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>

          {showDetails && (
            <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-700">
              <ul className="divide-y divide-zinc-200 dark:divide-zinc-700">
                {results.map((result, index) => (
                  <li key={`${result.url}-${index}`} className="px-4 py-2">
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                          {result.title || "Untitled Feed"}
                        </p>
                        <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {result.url}
                        </p>
                        {result.error && (
                          <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                            {result.error}
                          </p>
                        )}
                      </div>
                      <span
                        className={`ml-2 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                          result.status === "imported"
                            ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                            : result.status === "skipped"
                              ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                              : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                        }`}
                      >
                        {result.status}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <Button variant="secondary" onClick={onReset}>
        Import another file
      </Button>
    </div>
  );
}

// ============================================================================
// Export Section
// ============================================================================

function ExportSection() {
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const utils = trpc.useUtils();

  const handleExport = useCallback(async () => {
    setError(null);
    setSuccess(false);
    setIsExporting(true);

    try {
      const data = await utils.subscriptions.export.fetch();

      // Create blob and download
      const blob = new Blob([data.opml], { type: "application/xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lion-reader-subscriptions-${new Date().toISOString().split("T")[0]}.opml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export subscriptions");
    } finally {
      setIsExporting(false);
    }
  }, [utils.subscriptions.export]);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-2 text-sm font-medium text-zinc-900 dark:text-zinc-50">Export to OPML</h3>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Download your subscriptions as an OPML file to import into another RSS reader.
      </p>

      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      {success && (
        <Alert variant="success" className="mb-4">
          Subscriptions exported successfully!
        </Alert>
      )}

      <Button onClick={handleExport} loading={isExporting} variant="secondary">
        <svg className="mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
          />
        </svg>
        Export subscriptions
      </Button>
    </div>
  );
}
