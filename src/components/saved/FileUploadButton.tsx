/**
 * FileUploadButton Component
 *
 * Button and dialog for uploading files to save for later reading.
 * Supports .docx, .html, and .md files.
 */

"use client";

import { useState, useRef, useCallback, type ChangeEvent, type DragEvent } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button, Alert, UploadIcon, DocumentIcon } from "@/components/ui";

// ============================================================================
// Constants
// ============================================================================

const SUPPORTED_EXTENSIONS = [".docx", ".html", ".htm", ".md", ".markdown"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// ============================================================================
// Types
// ============================================================================

interface FileUploadButtonProps {
  /** Optional class name for additional styling */
  className?: string;
  /** Callback when file is successfully uploaded */
  onSuccess?: () => void;
}

// ============================================================================
// Helper Functions
// ============================================================================

function isValidFileType(filename: string): boolean {
  const lower = filename.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// FileUploadButton Component
// ============================================================================

export function FileUploadButton({ className = "", onSuccess }: FileUploadButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const utils = trpc.useUtils();
  const uploadMutation = trpc.saved.uploadFile.useMutation({
    onSuccess: () => {
      toast.success("File uploaded successfully");
      // Invalidate queries to refresh the saved list and count
      utils.entries.list.invalidate({ type: "saved" });
      utils.entries.count.invalidate({ type: "saved" });
      onSuccess?.();
      handleClose();
    },
    onError: (err) => {
      setError(err.message);
      toast.error("Failed to upload file");
    },
  });

  const handleOpen = () => {
    setIsOpen(true);
    setSelectedFile(null);
    setError(null);
  };

  const handleClose = () => {
    setIsOpen(false);
    setSelectedFile(null);
    setError(null);
    setIsDragging(false);
  };

  const validateFile = useCallback((file: File): string | null => {
    if (!isValidFileType(file.name)) {
      return `Unsupported file type. Please upload ${SUPPORTED_EXTENSIONS.join(", ")} files.`;
    }
    if (file.size > MAX_FILE_SIZE) {
      return `File is too large (${formatFileSize(file.size)}). Maximum size is ${formatFileSize(MAX_FILE_SIZE)}.`;
    }
    return null;
  }, []);

  const handleFileSelect = useCallback(
    (file: File) => {
      const validationError = validateFile(file);
      if (validationError) {
        setError(validationError);
        setSelectedFile(null);
        return;
      }
      setError(null);
      setSelectedFile(file);
    },
    [validateFile]
  );

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;

    // Read file as base64
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove the data URL prefix (e.g., "data:application/...;base64,")
      const base64Content = result.split(",")[1];

      uploadMutation.mutate({
        content: base64Content,
        filename: selectedFile.name,
      });
    };
    reader.onerror = () => {
      setError("Failed to read file");
    };
    reader.readAsDataURL(selectedFile);
  };

  const handleBrowseClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <>
      {/* Upload Button */}
      <button
        type="button"
        onClick={handleOpen}
        className={`inline-flex items-center justify-center rounded-md p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:focus:ring-zinc-400 ${className}`}
        title="Upload file"
        aria-label="Upload file"
      >
        <UploadIcon className="h-5 w-5" />
        <span className="ui-text-sm ml-1.5 hidden sm:inline">Upload</span>
      </button>

      {/* Upload Dialog */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-50 bg-black/50 transition-opacity"
            onClick={handleClose}
            aria-hidden="true"
          />

          {/* Dialog */}
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
              className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
              role="dialog"
              aria-modal="true"
              aria-labelledby="upload-dialog-title"
            >
              <h2
                id="upload-dialog-title"
                className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50"
              >
                Upload File
              </h2>

              <p className="ui-text-sm mb-4 text-zinc-500 dark:text-zinc-400">
                Upload a document to save for later reading. Supported formats: Word (.docx), HTML,
                and Markdown (.md).
              </p>

              {error && (
                <Alert variant="error" className="mb-4">
                  {error}
                </Alert>
              )}

              {/* Drop Zone */}
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={handleBrowseClick}
                className={`mb-4 cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
                  isDragging
                    ? "border-zinc-500 bg-zinc-100 dark:border-zinc-400 dark:bg-zinc-800"
                    : selectedFile
                      ? "border-green-500 bg-green-50 dark:border-green-600 dark:bg-green-900/20"
                      : "border-zinc-300 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-600 dark:hover:border-zinc-500 dark:hover:bg-zinc-800"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={SUPPORTED_EXTENSIONS.join(",")}
                  onChange={handleInputChange}
                  className="hidden"
                />

                {selectedFile ? (
                  <div className="flex flex-col items-center">
                    <DocumentIcon className="h-10 w-10 text-green-600 dark:text-green-500" />
                    <p className="mt-2 font-medium text-zinc-900 dark:text-zinc-50">
                      {selectedFile.name}
                    </p>
                    <p className="ui-text-sm text-zinc-500 dark:text-zinc-400">
                      {formatFileSize(selectedFile.size)}
                    </p>
                    <p className="ui-text-xs mt-2 text-zinc-400 dark:text-zinc-500">
                      Click or drop a different file to replace
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center">
                    <UploadIcon className="h-10 w-10 text-zinc-400 dark:text-zinc-500" />
                    <p className="mt-2 font-medium text-zinc-900 dark:text-zinc-50">
                      Drop file here or click to browse
                    </p>
                    <p className="ui-text-sm text-zinc-500 dark:text-zinc-400">
                      .docx, .html, .md up to 10MB
                    </p>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3">
                <Button
                  variant="secondary"
                  onClick={handleClose}
                  disabled={uploadMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleUpload}
                  disabled={!selectedFile || uploadMutation.isPending}
                  loading={uploadMutation.isPending}
                >
                  Upload
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
