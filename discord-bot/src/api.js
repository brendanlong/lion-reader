const LION_READER_URL = process.env.LION_READER_URL || "https://lionreader.app";

/**
 * Save an article to Lion Reader
 * @param {string} token - API token
 * @param {string} url - URL to save
 * @param {boolean} dryRun - If true, don't actually save (used for token validation)
 * @returns {Promise<{success: boolean, error?: string, data?: object}>}
 */
export async function saveArticle(token, url, dryRun = false) {
  // For dry run, we just validate the token by checking if we can list entries
  // This avoids saving example.com during token validation
  if (dryRun) {
    try {
      const response = await fetch(`${LION_READER_URL}/api/trpc/entries.list`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ json: { limit: 1 } }),
      });

      if (response.status === 401) {
        return { success: false, error: "unauthorized" };
      }

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  try {
    const response = await fetch(`${LION_READER_URL}/api/v1/saved`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
    });

    if (response.status === 401) {
      return { success: false, error: "unauthorized" };
    }

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${text}` };
    }

    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
