/**
 * Privacy Policy Page
 *
 * Public page outlining Lion Reader's privacy practices,
 * including data collection, third-party services, and user rights.
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy - Lion Reader",
  description: "Privacy policy for Lion Reader, a modern feed reader",
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-12 dark:bg-zinc-950">
      <main className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="mb-8">
          <Link
            href="/"
            className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            &larr; Back to Lion Reader
          </Link>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Privacy Policy
          </h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            Last updated: December 2024
          </p>
        </div>

        {/* Content */}
        <div className="prose prose-zinc dark:prose-invert max-w-none">
          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Overview</h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              Lion Reader is committed to protecting your privacy. This policy explains what
              information we collect, how we use it, and your rights regarding your data.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Information We Collect
            </h2>
            <div className="mt-4 space-y-4">
              <div>
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">
                  Account Information
                </h3>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  When you create an account, we collect your email address and password (stored
                  securely using industry-standard hashing). If you sign in with Google or Apple, we
                  receive basic profile information from those providers.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">Feed Data</h3>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  We store the RSS/Atom feeds you subscribe to, articles from those feeds, and your
                  reading history (read/unread status, starred items). This data is used to provide
                  the core feed reading functionality.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">Saved Articles</h3>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  When you save articles using our bookmarklet, we store the article content and
                  metadata on our servers for your later access.
                </p>
              </div>
            </div>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Third-Party Services
            </h2>

            <div className="mt-4 space-y-6">
              <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">
                  Audio Narration (Groq)
                </h3>
                <p className="mt-2 text-zinc-600 dark:text-zinc-400">
                  When you use the audio narration feature, article content is sent to Groq to
                  convert it into speakable text. This processing expands abbreviations, formats
                  numbers for speech, and improves pronunciation. The processed narration text is
                  cached on our servers to avoid repeated processing.
                </p>
                <p className="mt-2 text-zinc-600 dark:text-zinc-400">
                  <strong>Important:</strong> The actual audio generation happens entirely on your
                  device using your browser&apos;s built-in text-to-speech capabilities. No audio
                  data is sent to external servers.
                </p>
                <p className="mt-2">
                  <a
                    href="https://groq.com/privacy-policy/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                  >
                    View Groq&apos;s Privacy Policy &rarr;
                  </a>
                </p>
              </div>

              <div>
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">
                  Authentication Providers
                </h3>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  If you choose to sign in with Google or Apple, we use their OAuth services. We
                  only receive basic profile information (email, name) necessary for account
                  creation. We do not access any other data from these providers.
                </p>
              </div>
            </div>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Cookies and Local Storage
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              We use essential cookies for authentication and session management. We also use local
              storage to save your preferences (such as narration voice settings and reading
              preferences). We do not use third-party tracking cookies or analytics.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Data Security</h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              We implement industry-standard security measures to protect your data, including
              encrypted connections (HTTPS), secure password hashing, and regular security updates.
              Your feed subscriptions and reading data are stored in secured databases with
              restricted access.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Data Retention
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              We retain your account data and feed subscriptions as long as your account is active.
              Feed article content is retained according to our feed refresh policies. You can
              export your data (via OPML export) or delete your account at any time.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Your Rights</h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">You have the right to:</p>
            <ul className="mt-2 list-disc space-y-1 pl-6 text-zinc-600 dark:text-zinc-400">
              <li>Access your personal data</li>
              <li>Export your feed subscriptions (OPML format)</li>
              <li>Correct inaccurate information</li>
              <li>Delete your account and associated data</li>
              <li>Opt out of optional features like narration</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Changes to This Policy
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              We may update this privacy policy from time to time. We will notify users of any
              material changes by posting the updated policy on this page with a new &quot;Last
              updated&quot; date.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Contact</h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              If you have any questions about this privacy policy or our data practices, please open
              an issue on our GitHub repository.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
