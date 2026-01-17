// URL regex that matches http/https URLs
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

// Domains to ignore (Discord embeds, images, etc.)
const IGNORED_DOMAINS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
  "tenor.com",
  "giphy.com",
]);

/**
 * Extract URLs from a message
 * @param {string} content - Message content
 * @returns {string[]} - Array of URLs
 */
export function extractUrls(content) {
  if (!content) return [];

  const matches = content.match(URL_REGEX) || [];

  return matches
    .map((url) => {
      // Clean up trailing punctuation that got captured
      return url.replace(/[.,;:!?)]+$/, "");
    })
    .filter((url) => {
      try {
        const parsed = new URL(url);
        // Filter out ignored domains
        if (IGNORED_DOMAINS.has(parsed.hostname)) {
          return false;
        }
        // Filter out common non-article URLs
        if (parsed.pathname.match(/\.(png|jpg|jpeg|gif|webp|mp4|webm|mov)$/i)) {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    });
}
