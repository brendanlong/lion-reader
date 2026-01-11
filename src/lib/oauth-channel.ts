/**
 * OAuth Channel Utility
 *
 * Provides cross-tab communication for OAuth flows, particularly important for
 * PWAs on mobile browsers (like Firefox Android) where OAuth may open in a
 * separate browser window rather than within the PWA.
 *
 * Uses BroadcastChannel as the primary method, with localStorage events as fallback.
 */

const OAUTH_CHANNEL_NAME = "lion-reader-oauth";
const OAUTH_COMPLETION_KEY = "oauth_completion";

export interface OAuthCompletionMessage {
  type: "oauth_complete";
  success: boolean;
  /** Where to redirect after OAuth completes */
  redirectTo: string;
  /** Timestamp to prevent stale messages */
  timestamp: number;
}

/**
 * Broadcast that OAuth has completed successfully.
 * Called from the OAuth callback page after setting the session cookie.
 */
export function broadcastOAuthComplete(redirectTo: string): void {
  const message: OAuthCompletionMessage = {
    type: "oauth_complete",
    success: true,
    redirectTo,
    timestamp: Date.now(),
  };

  // Primary method: BroadcastChannel (works cross-tab in same origin)
  try {
    const channel = new BroadcastChannel(OAUTH_CHANNEL_NAME);
    channel.postMessage(message);
    channel.close();
  } catch {
    // BroadcastChannel not supported, fall through to localStorage
  }

  // Secondary method: localStorage event (triggers storage event in other tabs)
  // This serves as a fallback and also allows detection via visibility change
  try {
    localStorage.setItem(OAUTH_COMPLETION_KEY, JSON.stringify(message));
  } catch {
    // localStorage not available
  }
}

/**
 * Check if OAuth has recently completed (for visibility change detection).
 * Returns the completion message if found and recent (within 5 minutes).
 */
export function checkOAuthCompletion(): OAuthCompletionMessage | null {
  try {
    const stored = localStorage.getItem(OAUTH_COMPLETION_KEY);
    if (!stored) return null;

    const message: OAuthCompletionMessage = JSON.parse(stored);

    // Check if the completion is recent (within 5 minutes)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    if (message.timestamp < fiveMinutesAgo) {
      // Stale completion, clean it up
      clearOAuthCompletion();
      return null;
    }

    return message;
  } catch {
    return null;
  }
}

/**
 * Clear the OAuth completion marker from localStorage.
 * Should be called after handling the completion.
 */
export function clearOAuthCompletion(): void {
  try {
    localStorage.removeItem(OAUTH_COMPLETION_KEY);
  } catch {
    // localStorage not available
  }
}

/**
 * Subscribe to OAuth completion events.
 * Returns a cleanup function to unsubscribe.
 *
 * @param callback - Called when OAuth completes in another tab/window
 */
export function subscribeToOAuthCompletion(
  callback: (message: OAuthCompletionMessage) => void
): () => void {
  const cleanupFns: (() => void)[] = [];

  // Primary method: BroadcastChannel
  try {
    const channel = new BroadcastChannel(OAUTH_CHANNEL_NAME);
    const handleMessage = (event: MessageEvent<OAuthCompletionMessage>) => {
      if (event.data?.type === "oauth_complete") {
        callback(event.data);
      }
    };
    channel.addEventListener("message", handleMessage);
    cleanupFns.push(() => {
      channel.removeEventListener("message", handleMessage);
      channel.close();
    });
  } catch {
    // BroadcastChannel not supported
  }

  // Secondary method: storage event (fires when localStorage changes in another tab)
  const handleStorage = (event: StorageEvent) => {
    if (event.key === OAUTH_COMPLETION_KEY && event.newValue) {
      try {
        const message: OAuthCompletionMessage = JSON.parse(event.newValue);
        if (message.type === "oauth_complete") {
          callback(message);
        }
      } catch {
        // Invalid JSON
      }
    }
  };
  window.addEventListener("storage", handleStorage);
  cleanupFns.push(() => window.removeEventListener("storage", handleStorage));

  // Return cleanup function
  return () => {
    for (const cleanup of cleanupFns) {
      cleanup();
    }
  };
}

/**
 * Check for OAuth completion when the page becomes visible.
 * This handles the case where the PWA is backgrounded during OAuth.
 *
 * @param callback - Called if OAuth has completed while the page was hidden
 */
export function checkOAuthOnVisibilityChange(
  callback: (message: OAuthCompletionMessage) => void
): () => void {
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      const completion = checkOAuthCompletion();
      if (completion) {
        callback(completion);
      }
    }
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);

  // Also check immediately in case we're already visible and OAuth completed
  if (document.visibilityState === "visible") {
    const completion = checkOAuthCompletion();
    if (completion) {
      // Use setTimeout to avoid calling callback synchronously during setup
      setTimeout(() => callback(completion), 0);
    }
  }

  return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
}
