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

import { useState, useRef, useCallback, useEffect } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { SettingsSectionHeading } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { UploadIcon, DownloadIcon, SpinnerIcon } from "@/components/ui/icon-button";
import { parseOpml, type OpmlFeed } from "@/server/feed/opml";

// ============================================================================
// Types
// ============================================================================

interface ImportResult {
  url: string;
  title: string | null;
  status: "imported" | "skipped" | "failed" | "pending";
  error?: string;
}

type ImportState =
  | { type: "idle" }
  | { type: "parsing" }
  | { type: "preview"; feeds: OpmlFeed[]; opmlContent: string }
  | { type: "queuing" } // Brief state while mutation is in flight
  | { type: "importing"; importId: string; totalFeeds: number }
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
      <SettingsSectionHeading>Import / Export</SettingsSectionHeading>
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
  // Base state for the import flow
  const [baseState, setBaseState] = useState<
    | { type: "idle" }
    | { type: "parsing" }
    | { type: "preview"; feeds: OpmlFeed[]; opmlContent: string }
    | { type: "queuing" }
    | { type: "importing"; importId: string; totalFeeds: number }
    | {
        type: "complete";
        imported: number;
        skipped: number;
        failed: number;
        results: ImportResult[];
      }
  >({ type: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const utils = trpc.useUtils();

  // Query to poll for import status when importing
  const importQuery = trpc.imports.get.useQuery(
    { id: baseState.type === "importing" ? baseState.importId : "" },
    {
      enabled: baseState.type === "importing",
      refetchInterval: (query) => {
        // Stop polling once complete or failed
        const status = query.state.data?.status;
        if (status === "completed" || status === "failed") {
          return false;
        }
        return 1000; // Poll every second while in progress
      },
    }
  );

  // Derive the effective import state from the query data
  // This replaces the useEffect approach to avoid setState in effects
  const importState: ImportState = (() => {
    if (baseState.type === "importing" && importQuery.data) {
      const status = importQuery.data.status;
      if (status === "completed" || status === "failed") {
        return {
          type: "complete" as const,
          imported: importQuery.data.importedCount,
          skipped: importQuery.data.skippedCount,
          failed: importQuery.data.failedCount,
          results: importQuery.data.results,
        };
      }
    }
    return baseState;
  })();

  // Invalidate subscriptions when import completes
  const prevCompleted = useRef(false);
  useEffect(() => {
    const isCompleted = importState.type === "complete" && baseState.type === "importing";
    if (isCompleted && !prevCompleted.current) {
      prevCompleted.current = true;
      utils.subscriptions.list.invalidate();
      utils.tags.list.invalidate();
      utils.entries.count.invalidate();
    } else if (baseState.type !== "importing") {
      prevCompleted.current = false;
    }
  }, [
    importState.type,
    baseState.type,
    utils.subscriptions.list,
    utils.tags.list,
    utils.entries.count,
  ]);

  const importMutation = trpc.subscriptions.import.useMutation({
    onSuccess: (data) => {
      if (data.totalFeeds === 0) {
        // Empty OPML, show complete immediately
        setBaseState({
          type: "complete",
          imported: 0,
          skipped: 0,
          failed: 0,
          results: [],
        });
      } else {
        // Start polling for progress
        setBaseState({
          type: "importing",
          importId: data.importId,
          totalFeeds: data.totalFeeds,
        });
      }
    },
    onError: (err) => {
      setError(err.message || "Failed to import feeds");
      setBaseState({ type: "idle" });
      toast.error("Failed to import feeds");
    },
  });

  const handleFileSelect = useCallback(async (file: File) => {
    setError(null);
    setBaseState({ type: "parsing" });

    // Validate file type
    if (!file.name.endsWith(".opml") && !file.name.endsWith(".xml")) {
      setError("Please select an OPML or XML file");
      setBaseState({ type: "idle" });
      return;
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      setError("File is too large (max 5MB)");
      setBaseState({ type: "idle" });
      return;
    }

    try {
      const content = await file.text();
      const feeds = await parseOpml(content);

      if (feeds.length === 0) {
        setError("No feeds found in the OPML file");
        setBaseState({ type: "idle" });
        return;
      }

      setBaseState({ type: "preview", feeds, opmlContent: content });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse OPML file");
      setBaseState({ type: "idle" });
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

    setBaseState({ type: "queuing" });
    importMutation.mutate({ opml: importState.opmlContent });
  }, [importState, importMutation]);

  const handleReset = useCallback(() => {
    setBaseState({ type: "idle" });
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  return (
    <Card>
      <h3 className="ui-text-sm text-body mb-2 font-medium">Import from OPML</h3>
      <p className="ui-text-sm text-muted mb-4">
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
            isDragOver ? "border-accent bg-accent-subtle" : "border-edge-input"
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
            <UploadIcon className="text-faint mx-auto h-12 w-12" />
            <p className="ui-text-sm text-muted mt-2">
              Drag and drop your OPML file here, or{" "}
              <span className="text-accent font-medium">browse</span>
            </p>
            <p className="ui-text-xs text-muted mt-1">Supports .opml and .xml files up to 5MB</p>
          </div>
        </div>
      )}

      {importState.type === "parsing" && (
        <div className="flex items-center justify-center py-8">
          <SpinnerIcon className="text-faint h-6 w-6" />
          <span className="ui-text-sm text-muted ml-2">Parsing OPML file...</span>
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

      {(importState.type === "queuing" || importState.type === "importing") && (
        <div className="py-4">
          <div className="mb-2 flex items-center">
            <SpinnerIcon className="text-accent h-5 w-5" />
            <span className="ui-text-sm text-body ml-2 font-medium">Importing feeds...</span>
          </div>
          {importState.type === "importing" && importQuery.data && (
            <div className="mb-2">
              <div className="bg-fill-muted h-2 w-full overflow-hidden rounded-full">
                <div
                  className="bg-accent h-full transition-all duration-300"
                  style={{
                    width: `${((importQuery.data.importedCount + importQuery.data.skippedCount + importQuery.data.failedCount) / importState.totalFeeds) * 100}%`,
                  }}
                />
              </div>
              <p className="ui-text-xs text-muted mt-1">
                {importQuery.data.importedCount +
                  importQuery.data.skippedCount +
                  importQuery.data.failedCount}{" "}
                of {importState.totalFeeds} feeds processed
              </p>
            </div>
          )}
          <p className="ui-text-xs text-muted">
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
    </Card>
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
        <p className="ui-text-sm text-body font-medium">
          Found {feeds.length} feed{feeds.length !== 1 ? "s" : ""} to import
        </p>
      </div>

      <div className="border-edge-strong mb-4 max-h-64 overflow-y-auto rounded-md border">
        <ul className="divide-edge-strong divide-y">
          {displayedFeeds.map((feed, index) => (
            <li key={`${feed.xmlUrl}-${index}`} className="px-4 py-3">
              <p className="ui-text-sm text-body font-medium">{feed.title || "Untitled Feed"}</p>
              <p className="ui-text-xs text-muted mt-0.5 truncate">{feed.xmlUrl}</p>
              {feed.category && feed.category.length > 0 && (
                <p className="ui-text-xs text-faint mt-1">Folder: {feed.category.join(" / ")}</p>
              )}
            </li>
          ))}
        </ul>
      </div>

      {hasMore && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="ui-text-sm text-accent hover:text-accent-hover mb-4 font-medium"
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
        <div className="bg-success-subtle rounded-md p-3">
          <p className="ui-text-2xl text-success font-bold">{imported}</p>
          <p className="ui-text-xs text-success">Imported</p>
        </div>
        <div className="bg-warning-subtle rounded-md p-3">
          <p className="ui-text-2xl text-warning font-bold">{skipped}</p>
          <p className="ui-text-xs text-warning">Skipped</p>
        </div>
        <div className="bg-danger-subtle rounded-md p-3">
          <p className="ui-text-2xl text-danger font-bold">{failed}</p>
          <p className="ui-text-xs text-danger">Failed</p>
        </div>
      </div>

      {results.length > 0 && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="ui-text-sm text-accent hover:text-accent-hover font-medium"
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>

          {showDetails && (
            <div className="border-edge-strong mt-2 max-h-64 overflow-y-auto rounded-md border">
              <ul className="divide-edge-strong divide-y">
                {results.map((result, index) => (
                  <li key={`${result.url}-${index}`} className="px-4 py-2">
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="ui-text-sm text-body truncate font-medium">
                          {result.title || "Untitled Feed"}
                        </p>
                        <p className="ui-text-xs text-muted truncate">{result.url}</p>
                        {result.error && (
                          <p className="ui-text-xs text-danger mt-1">{result.error}</p>
                        )}
                      </div>
                      <span
                        className={`ui-text-xs ml-2 shrink-0 rounded-full px-2 py-0.5 font-medium ${
                          result.status === "imported"
                            ? "bg-success-subtle text-success"
                            : result.status === "skipped"
                              ? "bg-warning-subtle text-warning"
                              : "bg-danger-subtle text-danger"
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
    <Card>
      <h3 className="ui-text-sm text-body mb-2 font-medium">Export to OPML</h3>
      <p className="ui-text-sm text-muted mb-4">
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
        <DownloadIcon className="mr-2 h-4 w-4" />
        Export subscriptions
      </Button>
    </Card>
  );
}
