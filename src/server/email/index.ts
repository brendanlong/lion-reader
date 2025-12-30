/**
 * Email processing module.
 * Exports types and functions for handling inbound newsletter emails.
 */

export {
  processInboundEmail,
  normalizeSenderEmail,
  extractToken,
  parseListUnsubscribeMailto,
  parseListUnsubscribeHttps,
  generateEmailContentHash,
  type InboundEmail,
  type ProcessEmailResult,
} from "./process-inbound";
