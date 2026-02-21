/**
 * Terms of Service Page
 *
 * Public page outlining Lion Reader's terms of service,
 * including acceptable use, usage limits, and account policies.
 */

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service - Lion Reader",
  description: "Terms of service for Lion Reader, a modern feed reader",
};

export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-12 dark:bg-zinc-950">
      <main className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="mb-8">
          <Link
            href="/"
            className="ui-text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            &larr; Back to Lion Reader
          </Link>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            Terms of Service
          </h1>
          <p className="ui-text-sm mt-2 text-zinc-500 dark:text-zinc-400">
            Last updated: February 2026
          </p>
        </div>

        {/* Content */}
        <div className="prose prose-zinc dark:prose-invert max-w-none">
          <section className="mb-8">
            <h2 className="ui-text-xl font-semibold text-zinc-900 dark:text-zinc-50">Overview</h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              Lion Reader is a free, open-source feed reader service. By creating an account or
              using the service, you agree to these Terms of Service. If you do not agree to these
              terms, you may not use the service.
            </p>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              Please also review our{" "}
              <Link href="/privacy" className="text-accent hover:text-accent-hover underline">
                Privacy Policy
              </Link>
              , which describes how we collect and use your data.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="ui-text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Eligibility and Geographic Restrictions
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              Lion Reader is available only to users located in the United States. By using this
              service, you represent that you are located in the United States.
            </p>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              <strong>Use of Lion Reader from the European Union is explicitly prohibited.</strong>{" "}
              This service is not designed to comply with the General Data Protection Regulation
              (GDPR) or other EU data protection laws. If you are located in the EU, you must not
              create an account or use this service.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="ui-text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              The Service
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              Lion Reader is a free service provided on an &quot;as is&quot; and &quot;as
              available&quot; basis. We make no warranties or guarantees regarding uptime,
              availability, or reliability. The service may be modified, suspended, or discontinued
              at any time without notice.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="ui-text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Acceptable Use
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              You agree to use Lion Reader only for lawful purposes and in a manner consistent with
              its intended use as a personal feed reader. You must not:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-6 text-zinc-600 dark:text-zinc-400">
              <li>Use the service for any illegal activity</li>
              <li>Attempt to gain unauthorized access to other users&apos; accounts or data</li>
              <li>Use the service to distribute malware, spam, or other harmful content</li>
              <li>
                Interfere with or disrupt the service, servers, or networks connected to the service
              </li>
              <li>
                Use automated tools, bots, or scripts to access the service in a manner that exceeds
                reasonable personal use
              </li>
              <li>
                Scrape, harvest, or collect data from the service beyond your own account data
              </li>
              <li>Resell, redistribute, or sublicense access to the service</li>
              <li>Use the service in any way that violates applicable laws or regulations</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="ui-text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Usage Limits
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              To ensure fair usage and maintain service stability, Lion Reader enforces the
              following limits. These limits are subject to change at any time.
            </p>
            <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <ul className="list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
                <li>
                  <strong>Subscriptions:</strong> Up to 500 active feed subscriptions per account
                </li>
                <li>
                  <strong>Feed size:</strong> Individual feed responses are limited to 10 MB
                </li>
                <li>
                  <strong>Feed entries:</strong> Up to 100 entries parsed per feed update
                </li>
                <li>
                  <strong>Saved articles:</strong> Individual saved article pages are limited to 5
                  MB
                </li>
                <li>
                  <strong>Email newsletters:</strong> Individual newsletter emails are limited to 2
                  MB
                </li>
                <li>
                  <strong>API rate limits:</strong> Requests are rate-limited to prevent abuse
                </li>
              </ul>
            </div>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              Exceeding these limits may result in requests being rejected. Persistent or deliberate
              attempts to circumvent these limits may result in account suspension or termination.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="ui-text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Account Termination
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              <strong>
                We reserve the right to suspend or terminate any account at any time and for any
                reason, with or without notice.
              </strong>{" "}
              This is a free service and access is provided at our discretion. Reasons for
              termination may include, but are not limited to:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-6 text-zinc-600 dark:text-zinc-400">
              <li>Violation of these Terms of Service</li>
              <li>Violation of the Acceptable Use policy above</li>
              <li>Abusive or excessive usage that impacts the service for other users</li>
              <li>Inactivity for an extended period</li>
              <li>Any reason at our sole discretion</li>
            </ul>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              You may also delete your account at any time. Upon termination, your personal data
              will be handled according to our{" "}
              <Link href="/privacy" className="text-accent hover:text-accent-hover underline">
                Privacy Policy
              </Link>
              .
            </p>
          </section>

          <section className="mb-8">
            <h2 className="ui-text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Intellectual Property
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              Lion Reader is open-source software. The source code is available on{" "}
              <a
                href="https://github.com/brendanlong/lion-reader"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:text-accent-hover underline"
              >
                GitHub
              </a>
              . Content you subscribe to or save through the service remains the property of its
              respective owners. We do not claim ownership of any content fetched from external
              feeds.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="ui-text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Limitation of Liability
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              To the maximum extent permitted by law, Lion Reader and its operators shall not be
              liable for any indirect, incidental, special, consequential, or punitive damages, or
              any loss of data, use, or profits, arising out of or related to your use of the
              service.
            </p>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              The service is provided &quot;as is&quot; without warranty of any kind, express or
              implied, including but not limited to warranties of merchantability, fitness for a
              particular purpose, or non-infringement.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="ui-text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              Changes to These Terms
            </h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              We may update these Terms of Service from time to time. We will notify users of
              material changes by posting the updated terms on this page with a new &quot;Last
              updated&quot; date. Your continued use of the service after changes are posted
              constitutes acceptance of the updated terms.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="ui-text-xl font-semibold text-zinc-900 dark:text-zinc-50">Contact</h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              If you have any questions about these Terms of Service, please open an issue on our{" "}
              <a
                href="https://github.com/brendanlong/lion-reader"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:text-accent-hover underline"
              >
                GitHub repository
              </a>
              .
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
