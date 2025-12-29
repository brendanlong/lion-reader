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
            Last updated: December 2025
          </p>
        </div>

        {/* Content */}
        <div className="prose prose-zinc dark:prose-invert max-w-none">
          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Overview</h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              Lion Reader is committed to protecting your privacy. We collect only the data
              necessary to provide our feed reading service. We do not sell, rent, or share your
              personal information with third parties for marketing purposes.
            </p>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              This policy explains what information we collect, how we use it, what third-party
              services we use, and your rights regarding your data.
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
                  When you create an account, we collect your email address and password. Passwords
                  are securely hashed using argon2 (industry-standard). If you sign in with Google or
                  Apple, we receive only your email address and profile ID from those providers—we do
                  not access any other data from your OAuth accounts.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">
                  Session Information
                </h3>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  We store session tokens (SHA-256 hashed), IP addresses, and user agent strings to
                  maintain your login sessions and prevent unauthorized access. You can view and
                  revoke active sessions from your account settings.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">Feed Data</h3>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  We store the RSS/Atom feeds you subscribe to, articles from those feeds, and your
                  reading history (read/unread status, starred items, folder organization). This data
                  is used to provide the core feed reading functionality.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">Saved Articles</h3>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  When you save articles using our bookmarklet or save feature, we store the article
                  content and metadata on our servers for your later access.
                </p>
              </div>
              <div>
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">
                  Email Newsletter Subscriptions
                </h3>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  Each account has a unique email address for forwarding newsletters to your feed. If
                  you use this feature, we receive and store the newsletters sent to that address,
                  including sender information and email content.
                </p>
              </div>
            </div>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              How We Use Your Data
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              We use the information we collect solely to provide and improve Lion Reader&apos;s
              features:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-6 text-zinc-600 dark:text-zinc-400">
              <li>To maintain your account and authenticate you when you sign in</li>
              <li>To fetch, store, and display RSS/Atom feeds you subscribe to</li>
              <li>To track your reading progress (read/unread status, starred items)</li>
              <li>To enable optional features like audio narration and saved articles</li>
              <li>
                To monitor service health, diagnose errors, and improve performance (via Sentry and
                Grafana)
              </li>
              <li>To prevent abuse and maintain security of the service</li>
            </ul>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              <strong>
                We do not use your data for advertising, marketing to third parties, or any purpose
                unrelated to providing the Lion Reader service.
              </strong>
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Data Sharing and Disclosure
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              We do not sell, rent, or share your personal information with third parties for their
              marketing purposes. We only share data with third-party service providers as necessary
              to operate the service (see Third-Party Services section below).
            </p>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              We may disclose your information if required by law, such as in response to a valid
              subpoena or court order, or to protect the security and integrity of our service.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Third-Party Services
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              We use the following third-party services to operate Lion Reader:
            </p>

            <div className="mt-4 space-y-6">
              <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">
                  Audio Narration (Groq) — Optional
                </h3>
                <p className="mt-2 text-zinc-600 dark:text-zinc-400">
                  <strong>This feature is optional and disabled by default.</strong> When you enable
                  AI text processing in narration settings, article content is sent to Groq (using
                  their Llama 3.1 8B model) to convert it into speakable text. This preprocessing
                  expands abbreviations, formats numbers for speech, and improves pronunciation. The
                  processed text is cached on our servers to avoid repeated processing.
                </p>
                <p className="mt-2 text-zinc-600 dark:text-zinc-400">
                  When AI processing is disabled, we use simple HTML-to-text conversion that happens
                  entirely on our servers. Either way, the actual audio generation happens entirely
                  on your device using your browser&apos;s built-in text-to-speech. No audio data is
                  sent to external servers.
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
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">Hosting (Fly.io)</h3>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  Our application and databases are hosted on Fly.io infrastructure in the United
                  States. All data at rest is encrypted using Fly.io&apos;s managed PostgreSQL
                  service. Fly.io has access to server data as part of providing infrastructure
                  services.
                </p>
              </div>

              <div>
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">
                  Error Tracking (Sentry)
                </h3>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  We use Sentry to track application errors and performance issues. Sentry may
                  receive error messages, stack traces, and limited context about the operation that
                  failed (e.g., which page you were on). We do not send article content or feed data
                  to Sentry.
                </p>
              </div>

              <div>
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">
                  Monitoring (Grafana Cloud)
                </h3>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  We use Grafana Cloud for application metrics and logs to monitor service health and
                  performance. This includes anonymized usage metrics (e.g., number of API requests)
                  and system logs. We do not send personal information or article content to Grafana.
                </p>
              </div>

              <div>
                <h3 className="font-medium text-zinc-800 dark:text-zinc-200">
                  Authentication Providers (Google, Apple)
                </h3>
                <p className="mt-1 text-zinc-600 dark:text-zinc-400">
                  If you choose to sign in with Google or Apple, we use their OAuth services. We only
                  receive your email address and profile ID—we do not access any other data from
                  these providers.
                </p>
              </div>
            </div>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Cookies and Local Storage
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              We use essential cookies for authentication and session management. We also use browser
              storage to save your preferences and cached data:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-6 text-zinc-600 dark:text-zinc-400">
              <li>
                <strong>localStorage:</strong> Narration voice settings, reading preferences (show/hide
                read items, sort order), and keyboard shortcut preferences
              </li>
              <li>
                <strong>IndexedDB:</strong> Enhanced narration voices (if you download optional
                high-quality voices using Piper TTS). These voice files are stored locally on your
                device and never sent to our servers.
              </li>
            </ul>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              We do not use third-party tracking cookies, analytics, or advertising cookies.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Data Security</h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              We implement industry-standard security measures to protect your data:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-6 text-zinc-600 dark:text-zinc-400">
              <li>
                <strong>Encrypted connections:</strong> All data transmitted between your device and
                our servers uses HTTPS encryption
              </li>
              <li>
                <strong>Secure password storage:</strong> Passwords are hashed using argon2, a
                memory-hard algorithm resistant to brute-force attacks
              </li>
              <li>
                <strong>Session token security:</strong> Session tokens are SHA-256 hashed before
                storage and never stored in plain text
              </li>
              <li>
                <strong>Database encryption:</strong> All data at rest is encrypted using Fly.io&apos;s
                managed PostgreSQL encryption
              </li>
              <li>
                <strong>Regular security updates:</strong> We keep our dependencies and infrastructure
                up to date with security patches
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Data Retention
            </h2>
            <ul className="mt-2 list-disc space-y-1 pl-6 text-zinc-600 dark:text-zinc-400">
              <li>
                <strong>Account data:</strong> Retained as long as your account is active
              </li>
              <li>
                <strong>Sessions:</strong> Active sessions remain until you log out or they expire
                (configurable expiration). Revoked sessions are deleted immediately.
              </li>
              <li>
                <strong>Feed content:</strong> Shared feed data is retained as long as any user is
                subscribed to that feed. When you unsubscribe, your personal reading state is
                retained (soft delete) so you can resubscribe and maintain your history.
              </li>
              <li>
                <strong>Saved articles:</strong> Retained until you delete them
              </li>
              <li>
                <strong>Narration cache:</strong> Preprocessed narration text is cached indefinitely
                to avoid repeated processing
              </li>
              <li>
                <strong>Logs and metrics:</strong> Application logs and error reports are retained
                for 30 days for troubleshooting and performance monitoring
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Your Rights</h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              You have the following rights regarding your personal data:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-6 text-zinc-600 dark:text-zinc-400">
              <li>
                <strong>Access:</strong> View all your personal data through your account settings
              </li>
              <li>
                <strong>Export:</strong> Download your feed subscriptions in OPML format for import
                into other RSS readers
              </li>
              <li>
                <strong>Correct:</strong> Update your email address and other account information at
                any time
              </li>
              <li>
                <strong>Revoke access:</strong> Disconnect OAuth accounts (Google, Apple) and revoke
                individual login sessions from your account settings
              </li>
              <li>
                <strong>Control features:</strong> Disable optional features like AI text processing
                for narration at any time
              </li>
              <li>
                <strong>Delete:</strong> Request account deletion by contacting us (see Contact
                section below). We are working on self-service account deletion.
              </li>
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
