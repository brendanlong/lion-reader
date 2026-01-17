/**
 * Landing Page
 *
 * Shows a landing page for unauthenticated users.
 * Authenticated users are redirected to /all by middleware.
 */

import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <main className="w-full max-w-2xl text-center">
        {/* Logo / Brand */}
        <h1 className="text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
          Lion Reader
        </h1>
        <p className="mt-4 text-lg text-zinc-600 dark:text-zinc-400">
          A modern, fast, and open-source feed reader.
          <br />
          Stay on top of your favorite blogs, news, and podcasts.
        </p>

        {/* CTA Buttons */}
        <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Link
            href="/register"
            className="inline-flex h-12 w-full items-center justify-center rounded-md bg-zinc-900 px-6 text-base font-medium text-white transition-colors hover:bg-zinc-800 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none sm:w-auto dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:focus:ring-zinc-400"
          >
            Get started
          </Link>
          <Link
            href="/login"
            className="inline-flex h-12 w-full items-center justify-center rounded-md border border-zinc-300 bg-white px-6 text-base font-medium text-zinc-900 transition-colors hover:bg-zinc-50 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none sm:w-auto dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:ring-zinc-400"
          >
            Sign in
          </Link>
        </div>

        {/* Features */}
        <div className="mt-16 grid gap-8 sm:grid-cols-3">
          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Fast & Efficient
            </h3>
            <p className="ui-text-sm mt-2 text-zinc-600 dark:text-zinc-400">
              Stay up to date with all your feeds in one place. We fetch and organize content
              automatically.
            </p>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              RSS & Atom Support
            </h3>
            <p className="ui-text-sm mt-2 text-zinc-600 dark:text-zinc-400">
              Subscribe to any RSS or Atom feed. We handle the parsing so you can focus on reading.
            </p>
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Open API</h3>
            <p className="ui-text-sm mt-2 text-zinc-600 dark:text-zinc-400">
              Use our REST API to build your own clients or integrate with other tools.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
