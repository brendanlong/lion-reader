/**
 * Footer component for auth pages (login/register)
 *
 * Displays attribution and GitHub link in a compact format.
 */

export function AuthFooter() {
  return (
    <footer className="mt-8 border-t border-zinc-200 pt-6 dark:border-zinc-800">
      <p className="text-center text-xs text-zinc-500 dark:text-zinc-500">
        Created by{" "}
        <a
          href="https://www.brendanlong.com"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-zinc-900 hover:underline dark:hover:text-zinc-300"
        >
          Brendan Long
        </a>{" "}
        and{" "}
        <a
          href="https://www.brendanlong.com/claude-wrote-me-a-400-commit-rss-reader-app.html"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-zinc-900 hover:underline dark:hover:text-zinc-300"
        >
          Claude
        </a>{" "}
        •{" "}
        <a
          href="https://github.com/brendanlong/lion-reader"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-zinc-900 hover:underline dark:hover:text-zinc-300"
        >
          View on GitHub
        </a>
      </p>
    </footer>
  );
}
