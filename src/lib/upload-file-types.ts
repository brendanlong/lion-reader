/**
 * Upload extensions and the converter each one uses. Shared by the server's
 * type detection and the Upload button's file picker so they can't disagree.
 * Plain text goes through the Markdown converter, which renders it as paragraphs.
 */
export const UPLOAD_FILE_TYPES = {
  ".docx": "docx",
  ".html": "html",
  ".htm": "html",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "markdown",
} as const;

export type SupportedFileType = (typeof UPLOAD_FILE_TYPES)[keyof typeof UPLOAD_FILE_TYPES];

export const SUPPORTED_UPLOAD_EXTENSIONS = Object.keys(UPLOAD_FILE_TYPES) as Array<
  keyof typeof UPLOAD_FILE_TYPES
>;
