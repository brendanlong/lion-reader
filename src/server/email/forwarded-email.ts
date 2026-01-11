/**
 * Forwarded Email Detection and Parsing
 *
 * Handles emails that have been forwarded to the ingest address.
 * Extracts the original sender from the forwarded content and adds
 * a "Forwarded by" attribution block.
 *
 * Supported email client formats:
 * - Gmail: "---------- Forwarded message ---------"
 * - Apple Mail: "Begin forwarded message:"
 * - Outlook: "-------- Original Message --------" / "-----Original Message-----"
 * - Generic: Various "Forwarded message" patterns
 */

import { parseFromAddress } from "./parse-from-address";

// ============================================================================
// Types
// ============================================================================

/**
 * Original sender information extracted from a forwarded email.
 */
export interface ExtractedOriginalSender {
  /** Original sender email address */
  address: string;
  /** Original sender display name (optional) */
  name?: string;
}

/**
 * Result of parsing a forwarded email.
 */
export interface ForwardedEmailParseResult {
  /** Whether the email appears to be forwarded */
  isForwarded: boolean;
  /** Original sender information (if extracted) */
  originalSender?: ExtractedOriginalSender;
  /** Original subject (with "Fwd:" stripped) */
  cleanedSubject?: string;
  /** The original email subject as found in the forwarded content */
  originalSubject?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Subject prefixes that indicate a forwarded email.
 * Case-insensitive matching.
 */
const FORWARD_SUBJECT_PREFIXES = [
  "fwd:",
  "fw:",
  "fwd :",
  "fw :",
  "forward:",
  "[fwd]",
  "[fw]",
  "fwd -",
  "fw -",
  "wg:", // German "Weitergeleitet"
  "rv:", // Spanish "Reenviado"
  "tr:", // French "Transféré"
  "i:", // Italian "Inoltrato"
];

/**
 * Patterns that indicate the start of a forwarded message block.
 * Each pattern is a regex with optional capture groups.
 */
const FORWARD_BLOCK_PATTERNS = [
  // Gmail format
  /[-]{5,}\s*Forwarded message\s*[-]{5,}/i,
  // Apple Mail format
  /Begin forwarded message:/i,
  // Outlook formats
  /[-]{4,}\s*Original Message\s*[-]{4,}/i,
  /_{4,}\s*Original Message\s*_{4,}/i,
  // Generic formats
  /[-]{4,}\s*Forwarded by\s+.*[-]{4,}/i,
  />\s*Begin forwarded message/i,
];

/**
 * Pattern to extract "From:" header from forwarded email body.
 * Handles multiple formats:
 * - "From: Name <email@example.com>"
 * - "From: email@example.com"
 * - "*From:* Name <email@example.com>" (bold in some HTML)
 */
const FROM_HEADER_PATTERNS = [
  // Plain text format - most common (multiline mode makes ^ match start of lines)
  /^\s*From:\s*(.+)$/im,
  // With leading > (quoted text)
  /^>\s*From:\s*(.+)$/im,
  // HTML bold format (Gmail sometimes uses this)
  /<b>From:<\/b>\s*(.+?)(?:<br|<\/|$)/i,
  // HTML with class (various webmail)
  /class="[^"]*from[^"]*"[^>]*>.*?:\s*(.+?)(?:<|$)/i,
];

/**
 * Pattern to extract "Subject:" header from forwarded email body.
 */
const SUBJECT_HEADER_PATTERNS = [
  // Plain text format (multiline mode makes ^ match start of lines)
  /^\s*Subject:\s*(.+)$/im,
  // With leading > (quoted text)
  /^>\s*Subject:\s*(.+)$/im,
  // HTML bold format
  /<b>Subject:<\/b>\s*(.+?)(?:<br|<\/|$)/i,
];

// ============================================================================
// Pure Functions
// ============================================================================

/**
 * Checks if a subject line indicates a forwarded email.
 *
 * @param subject - The email subject to check
 * @returns Whether the subject starts with a forward prefix
 */
export function hasForwardPrefix(subject: string): boolean {
  const lowerSubject = subject.toLowerCase().trim();
  return FORWARD_SUBJECT_PREFIXES.some((prefix) => lowerSubject.startsWith(prefix));
}

/**
 * Strips the forward prefix from a subject line.
 *
 * @param subject - The email subject
 * @returns Subject with forward prefix removed, or original if no prefix
 */
export function stripForwardPrefix(subject: string): string {
  const trimmed = subject.trim();
  const lowerSubject = trimmed.toLowerCase();

  for (const prefix of FORWARD_SUBJECT_PREFIXES) {
    if (lowerSubject.startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }

  return trimmed;
}

/**
 * Checks if the email body contains a forwarded message block.
 *
 * @param content - The email body (HTML or plain text)
 * @returns Whether a forwarded message block pattern was found
 */
export function hasForwardedBlock(content: string): boolean {
  return FORWARD_BLOCK_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * Extracts the original "From:" address from a forwarded email body.
 * Looks for the From header in the forwarded content.
 *
 * @param content - The email body (HTML or plain text)
 * @returns Parsed sender information or undefined if not found
 */
export function extractOriginalSenderFromBody(
  content: string
): ExtractedOriginalSender | undefined {
  for (const pattern of FROM_HEADER_PATTERNS) {
    const match = content.match(pattern);
    if (match?.[1]) {
      // Clean up the captured value - decode HTML entities first
      let fromValue = match[1]
        .trim()
        // Decode HTML entities
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'");

      // Remove HTML tags only - be careful to preserve email addresses in angle brackets
      // HTML tags look like <tag> or </tag> or <tag attr="val">
      // Email addresses look like <email@domain.com>
      // The key difference: email addresses contain @ before >
      fromValue = fromValue.replace(/<([^@>]+)>/g, (match, inner) => {
        // Keep it if it looks like it might be part of an email format
        // (doesn't look like an HTML tag)
        if (/^[a-zA-Z][a-zA-Z0-9]*(\s|$|\/|>)/.test(inner.trim())) {
          // Looks like HTML tag, remove it
          return "";
        }
        return match; // Keep email-like angle brackets
      });

      fromValue = fromValue.trim();

      // Skip if the value looks invalid (too short or no @)
      if (fromValue.length < 3 || !fromValue.includes("@")) {
        continue;
      }

      const parsed = parseFromAddress(fromValue);
      if (parsed.address && parsed.address.includes("@")) {
        return {
          address: parsed.address,
          name: parsed.name,
        };
      }
    }
  }

  return undefined;
}

/**
 * Extracts the original subject from a forwarded email body.
 *
 * @param content - The email body (HTML or plain text)
 * @returns The original subject or undefined if not found
 */
export function extractOriginalSubjectFromBody(content: string): string | undefined {
  for (const pattern of SUBJECT_HEADER_PATTERNS) {
    const match = content.match(pattern);
    if (match?.[1]) {
      const subject = match[1]
        .trim()
        // Remove HTML entities
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        // Remove HTML tags
        .replace(/<[^>]+>/g, "")
        .trim();

      if (subject.length > 0) {
        return subject;
      }
    }
  }

  return undefined;
}

/**
 * Detects if an email is forwarded and extracts original sender information.
 *
 * Detection is based on:
 * 1. Subject prefix (Fwd:, Fw:, etc.)
 * 2. Forwarded message block in body
 *
 * @param subject - The email subject
 * @param content - The email body (HTML or plain text)
 * @returns Parse result with original sender info if found
 */
export function parseForwardedEmail(subject: string, content: string): ForwardedEmailParseResult {
  const hasSubjectPrefix = hasForwardPrefix(subject);
  const hasBodyBlock = hasForwardedBlock(content);

  // Email is forwarded if it has either indicator
  const isForwarded = hasSubjectPrefix || hasBodyBlock;

  if (!isForwarded) {
    return { isForwarded: false };
  }

  // Extract original sender from body
  const originalSender = extractOriginalSenderFromBody(content);

  // Extract and clean subject
  const cleanedSubject = hasSubjectPrefix ? stripForwardPrefix(subject) : subject;
  const originalSubject = extractOriginalSubjectFromBody(content);

  return {
    isForwarded: true,
    originalSender,
    cleanedSubject,
    originalSubject,
  };
}

/**
 * Generates a "Forwarded by" attribution block to prepend to the email content.
 *
 * @param forwarderAddress - Email address of the person who forwarded
 * @param forwarderName - Display name of the forwarder (optional)
 * @param isHtml - Whether to generate HTML or plain text
 * @returns The attribution block
 */
export function generateForwardedByBlock(
  forwarderAddress: string,
  forwarderName: string | undefined,
  isHtml: boolean
): string {
  const forwarderDisplay = forwarderName
    ? `${forwarderName} (${forwarderAddress})`
    : forwarderAddress;

  if (isHtml) {
    return `<div style="background-color: #f5f5f5; border-left: 3px solid #ccc; padding: 10px 15px; margin-bottom: 15px; font-size: 14px; color: #666;">
  <strong>Forwarded by:</strong> ${escapeHtml(forwarderDisplay)}
</div>`;
  }

  return `[Forwarded by: ${forwarderDisplay}]\n\n`;
}

/**
 * Escapes HTML special characters for safe inclusion in HTML.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Prepends the "Forwarded by" block to email content.
 *
 * @param content - Original email content
 * @param forwarderAddress - Email address of the forwarder
 * @param forwarderName - Display name of the forwarder (optional)
 * @param isHtml - Whether the content is HTML
 * @returns Content with forwarded-by block prepended
 */
export function prependForwardedByBlock(
  content: string,
  forwarderAddress: string,
  forwarderName: string | undefined,
  isHtml: boolean
): string {
  const block = generateForwardedByBlock(forwarderAddress, forwarderName, isHtml);

  if (isHtml) {
    // Insert after <body> tag if present, otherwise prepend
    const bodyMatch = content.match(/(<body[^>]*>)/i);
    if (bodyMatch) {
      return content.replace(bodyMatch[0], `${bodyMatch[0]}${block}`);
    }
    return block + content;
  }

  return block + content;
}
