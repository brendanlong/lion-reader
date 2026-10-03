/**
 * Privacy Policy Page
 *
 * Public page outlining Lion Reader's privacy practices,
 * including data collection, third-party services, and user rights.
 */

import type { Metadata } from "next";
import {
  LegalList,
  LegalPage,
  LegalParagraph,
  LegalSection,
  LegalSubsection,
} from "@/components/legal/LegalProse";
import { Card } from "@/components/ui/card";
import { PageLink } from "@/components/ui/page-link";
import { TextLink } from "@/components/ui/text-link";

export const metadata: Metadata = {
  title: "Privacy Policy - Lion Reader",
  description: "Privacy policy for Lion Reader, a modern feed reader",
};

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="October 3, 2026">
      <LegalSection title="Overview">
        <LegalParagraph>
          Lion Reader is committed to protecting your privacy. We collect only the data necessary to
          provide our feed reading service. We do not sell, rent, or share your personal information
          with third parties for marketing purposes.
        </LegalParagraph>
        <LegalParagraph>
          This policy explains what information we collect, how we use it, what third-party services
          we use, and your rights regarding your data.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Information We Collect">
        <div className="mt-4 space-y-4">
          <LegalSubsection title="Account Information">
            <LegalParagraph tight>
              When you create an account, we collect your email address and password. Passwords are
              securely hashed using argon2 (industry-standard). If you sign in with Google, Apple,
              or Discord, we store your email address and account ID from that provider, plus the
              sign-in tokens it issues (see Authentication Providers below).
            </LegalParagraph>
          </LegalSubsection>
          <LegalSubsection title="Session Information">
            <LegalParagraph tight>
              We store session tokens (SHA-256 hashed), IP addresses, and user agent strings to
              maintain your login sessions and prevent unauthorized access. You can view and revoke
              active sessions from your account settings.
            </LegalParagraph>
          </LegalSubsection>
          <LegalSubsection title="Feed Data">
            <LegalParagraph tight>
              We store the RSS/Atom feeds you subscribe to, articles from those feeds, and your
              reading history (read/unread status, starred items, folder organization). This data is
              used to provide the core feed reading functionality.
            </LegalParagraph>
          </LegalSubsection>
          <LegalSubsection title="Saved Articles">
            <LegalParagraph tight>
              When you save articles using our bookmarklet or save feature, we store the article
              content and metadata on our servers for your later access.
            </LegalParagraph>
          </LegalSubsection>
          <LegalSubsection title="Email Newsletter Subscriptions">
            <LegalParagraph tight>
              Each account has a unique email address for forwarding newsletters to your feed. If
              you use this feature, we receive and store the newsletters sent to that address,
              including sender information and email content.
            </LegalParagraph>
          </LegalSubsection>
        </div>
      </LegalSection>

      <LegalSection title="How We Use Your Data">
        <LegalParagraph>
          We use the information we collect to provide, operate, and improve the Lion Reader
          service. This includes:
        </LegalParagraph>
        <LegalList>
          <li>To maintain your account and authenticate you when you sign in</li>
          <li>To fetch, store, and display RSS/Atom feeds you subscribe to</li>
          <li>To track your reading progress (read/unread status, starred items)</li>
          <li>
            To enable optional features like article summarization, audio narration, saved articles,
            and Discord integration
          </li>
          <li>
            To monitor service health, diagnose errors, and improve performance (via Sentry and
            Grafana)
          </li>
          <li>
            To count page views so we know how many people use the site and which parts get used
            (via GoatCounter, which receives only the type of page, never which list or article)
          </li>
          <li>To prevent abuse and maintain security of the service</li>
          <li>
            To administer the service, including managing user accounts, monitoring feed health, and
            managing invite codes (see Administrative Access below)
          </li>
        </LegalList>
        <LegalParagraph>
          <strong>
            We do not use your data for advertising, marketing to third parties, or any purpose
            unrelated to providing the Lion Reader service.
          </strong>
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Administrative Access">
        <LegalParagraph>
          Lion Reader administrators have access to an internal admin portal used to operate and
          maintain the service. This portal is protected by a separate secret and is not accessible
          to regular users. Through the admin portal, administrators can view:
        </LegalParagraph>
        <LegalList>
          <li>
            <strong>User information:</strong> Email addresses, account creation dates, linked
            sign-in providers (e.g., Google, Apple, Discord), number of feed subscriptions, number
            of entries, and when the account was last active in the app or through the API
          </li>
          <li>
            <strong>Feed health data:</strong> Feed URLs, titles, fetch error details, subscriber
            counts, entry counts, and fetch sizes — used to diagnose and resolve feed issues
          </li>
          <li>
            <strong>Invite management:</strong> Invite codes, their status (pending, used, expired),
            and which user claimed each invite
          </li>
        </LegalList>
        <LegalParagraph>
          Administrative access is used solely for service operation, troubleshooting, and user
          support.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Data Sharing and Disclosure">
        <LegalParagraph>
          We do not sell, rent, or share your personal information with third parties for their
          marketing purposes. We only share data with third-party service providers as necessary to
          operate the service (see Third-Party Services section below).
        </LegalParagraph>
        <LegalParagraph>
          We may disclose your information if required by law, such as in response to a valid
          subpoena or court order, or to protect the security and integrity of our service.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Third-Party Services">
        <LegalParagraph>
          We use the following third-party services to operate Lion Reader:
        </LegalParagraph>

        <div className="mt-4 space-y-6">
          <Card padding="md">
            <LegalSubsection title="Article Summarization (Anthropic, Cerebras, Groq, OpenRouter) — Optional">
              <LegalParagraph>
                <strong>This feature is optional and off by default.</strong> Summarization only
                happens when you explicitly request a summary for an article and a summarization
                model has been configured (either your own API key or a server-provided one). When
                you generate a summary, the article&apos;s title and text content are sent to your
                chosen AI provider—Anthropic, Cerebras, Groq, or OpenRouter—to produce the summary.
              </LegalParagraph>
              <LegalParagraph>
                OpenRouter is a gateway that forwards each request to a company hosting the model
                you picked (for example Google, Anthropic, or an open-weights host), so when you
                choose an OpenRouter model that host also receives the article text.
              </LegalParagraph>
              <LegalParagraph>
                You choose which provider and model to use in your settings, and you may provide a
                custom summarization prompt. Generated summaries are cached on our servers so the
                same article does not need to be reprocessed.
              </LegalParagraph>
              <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                <TextLink
                  href="https://www.anthropic.com/legal/privacy"
                  external
                  className="ui-text-sm"
                >
                  Anthropic&apos;s Privacy Policy &rarr;
                </TextLink>
                <TextLink
                  href="https://www.cerebras.ai/privacy-policy"
                  external
                  className="ui-text-sm"
                >
                  Cerebras&apos;s Privacy Policy &rarr;
                </TextLink>
                <TextLink href="https://groq.com/privacy-policy/" external className="ui-text-sm">
                  Groq&apos;s Privacy Policy &rarr;
                </TextLink>
                <TextLink href="https://openrouter.ai/privacy" external className="ui-text-sm">
                  OpenRouter&apos;s Privacy Policy &rarr;
                </TextLink>
              </p>
            </LegalSubsection>
          </Card>

          <Card padding="md">
            <LegalSubsection title="Audio Narration (Cerebras, Groq, OpenRouter, DeepInfra, BreezeBlue) — Optional">
              <LegalParagraph>
                <strong>This feature is optional and disabled by default.</strong> When you enable
                AI text processing in narration settings, article content is sent to the AI provider
                you chose—Cerebras, Groq, or OpenRouter—to convert it into speakable text. This
                preprocessing expands abbreviations, formats numbers for speech, and improves
                pronunciation. The processed text is cached on our servers to avoid repeated
                processing.
              </LegalParagraph>
              <LegalParagraph>
                When AI processing is disabled, the article is converted to speakable text on your
                device.
              </LegalParagraph>
              <LegalParagraph>
                With browser or enhanced voices, audio is generated entirely on your device. If you
                choose <strong>Cloud Voices</strong> (off by default), the text being narrated is
                sent to the provider of the speech model you picked to generate the audio: DeepInfra
                directly (the default, Kokoro), BreezeBlue directly, or OpenRouter, which forwards
                it to the company hosting that model (for example DeepInfra or Together). The
                generated audio is streamed back to your device and not stored on our servers. We
                ask BreezeBlue not to save the text or audio in the generation history of the
                account whose key was used.
              </LegalParagraph>
              <LegalParagraph>
                In the Android app, device voices send the article text to your device&apos;s
                text-to-speech engine; if that engine uses online voices, its provider processes the
                text under its own terms. Cloud Voices in the app work as described above, and the
                audio is cached only on your device.
              </LegalParagraph>
              <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                <TextLink
                  href="https://www.cerebras.ai/privacy-policy"
                  external
                  className="ui-text-sm"
                >
                  Cerebras&apos;s Privacy Policy &rarr;
                </TextLink>
                <TextLink href="https://groq.com/privacy-policy/" external className="ui-text-sm">
                  Groq&apos;s Privacy Policy &rarr;
                </TextLink>
                <TextLink href="https://openrouter.ai/privacy" external className="ui-text-sm">
                  OpenRouter&apos;s Privacy Policy &rarr;
                </TextLink>
                <TextLink href="https://deepinfra.com/privacy" external className="ui-text-sm">
                  DeepInfra&apos;s Privacy Policy &rarr;
                </TextLink>
                <TextLink
                  href="https://breezeblue.ai/legal/privacy"
                  external
                  className="ui-text-sm"
                >
                  BreezeBlue&apos;s Privacy Policy &rarr;
                </TextLink>
              </p>
            </LegalSubsection>
          </Card>

          <LegalSubsection title="Enhanced Voices (Hugging Face, jsDelivr) — Optional">
            <LegalParagraph tight>
              <strong>Only if you use enhanced (Piper) voices.</strong> Downloading an enhanced
              voice fetches the voice model directly from Hugging Face, and using one fetches the
              speech engine&apos;s files from the jsDelivr CDN. These requests go straight from your
              browser to those services, so they see your IP address and browser user agent, as with
              any download. No article text or account information is sent; speech is then generated
              entirely on your device.
            </LegalParagraph>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              <TextLink href="https://huggingface.co/privacy" external className="ui-text-sm">
                Hugging Face&apos;s Privacy Policy &rarr;
              </TextLink>
              <TextLink
                href="https://www.jsdelivr.com/terms/privacy-policy"
                external
                className="ui-text-sm"
              >
                jsDelivr&apos;s Privacy Policy &rarr;
              </TextLink>
            </p>
          </LegalSubsection>

          <LegalSubsection title="Hosting (Fly.io)">
            <LegalParagraph tight>
              Our application and databases are hosted on Fly.io infrastructure in the United
              States. All data at rest is encrypted using Fly.io&apos;s managed PostgreSQL service.
              Fly.io has access to server data as part of providing infrastructure services.
            </LegalParagraph>
            <LegalParagraph tight>
              As part of running the platform, Fly.io records its own operational metrics for our
              app — request counts, response times, error rates, and bandwidth — aggregated by the
              edge region that served each request, which is a rough geographic area rather than a
              location. This is standard infrastructure monitoring that comes with the platform, and
              it is not tied to your account.
            </LegalParagraph>
          </LegalSubsection>

          <LegalSubsection title="Content Delivery Network (Bunny.net)">
            <LegalParagraph tight>
              The app&apos;s static files (code, styles, fonts, and the demo&apos;s pre-recorded
              audio) are served from Bunny.net&apos;s content delivery network (cdn.lionreader.com),
              using only servers in the United States. Your browser fetches these files directly
              from Bunny.net, so Bunny.net sees your IP address and browser user agent, as with any
              download, and may keep them in its request logs under its own policy. These files are
              the same for everyone; no account information, reading activity, or article content
              passes through the CDN.
            </LegalParagraph>
            <p className="mt-2">
              <TextLink href="https://bunny.net/privacy/" external className="ui-text-sm">
                View Bunny.net&apos;s Privacy Policy &rarr;
              </TextLink>
            </p>
          </LegalSubsection>

          <LegalSubsection title="Error Tracking and Session Replay (Sentry)">
            <LegalParagraph tight>
              We use Sentry to find and fix errors and performance problems. When something goes
              wrong, Sentry receives the error message and where in our code it happened, along with
              what led up to it: the pages you visited, the requests the app made, the buttons and
              links you clicked, and messages the app logged. Errors on our servers include your
              account ID so we can investigate problems affecting a particular account. Sentry also
              receives timing data for a sample of page loads. We configure both Sentry and our own
              code not to store your IP address.
            </LegalParagraph>
            <LegalParagraph tight>
              <strong>Session Replay:</strong> for a random 10% of browser sessions, and for the
              minute or so before any error, Sentry also records a replay—the layout of each page,
              your clicks and scrolling, and the pages you visit—so we can see what led to a
              problem. Text and anything you type are masked, and images and media are blocked,
              before the recording leaves your browser, so a replay does not show the words on the
              page.
            </LegalParagraph>
            <LegalParagraph tight>
              <strong>Sentry can see what you were reading.</strong> Error reports and replays
              include web addresses: of the pages you visited, of the links on them (such as an
              article&apos;s original web address), and of the requests the app made. Depending on
              what you were doing, these can include the address of an article you opened or saved,
              a feed you previewed, your search terms, and the name of a feed whose button you
              clicked. We use this only to fix problems, and Sentry keeps it for 30 days.
            </LegalParagraph>
            <p className="mt-2">
              <TextLink href="https://sentry.io/privacy/" external className="ui-text-sm">
                View Sentry&apos;s Privacy Policy &rarr;
              </TextLink>
            </p>
          </LegalSubsection>

          <LegalSubsection title="Monitoring (Grafana Cloud)">
            <LegalParagraph tight>
              We use Grafana Cloud for application metrics and logs to monitor service health and
              performance. This includes anonymized usage metrics (e.g., number of API requests) and
              system logs. We do not send personal information or article content to Grafana.
            </LegalParagraph>
          </LegalSubsection>

          <LegalSubsection title="Authentication Providers (Google, Apple, Discord)">
            <LegalParagraph tight>
              If you choose to sign in with Google, Apple, or Discord, we use their OAuth services.
              We store your email address and account ID from the provider, plus the tokens it
              issues at sign-in. The providers also share your name (and Google your profile
              picture, Discord your username and avatar); we do not store these. We use the stored
              tokens only for Google Docs saving, described below.
            </LegalParagraph>
          </LegalSubsection>

          <LegalSubsection title="Google Docs Saving (Google) — Optional">
            <LegalParagraph tight>
              <strong>Only if you save a Google Doc.</strong> When you save a Google Doc (from the
              browser extension, the save page, or the bookmarklet) and we don&apos;t yet have
              access, we ask Google for read-only access to your Google Docs and to{" "}
              <strong>all files in your Google Drive</strong> (Google describes this as &quot;See
              and download all your Google Drive files&quot;). Drive access is needed to import
              uploaded Word documents. We use this access only to download the specific documents
              you choose to save, including saves made later through the extension or an app
              connected to your account, and we never modify or delete your files.
            </LegalParagraph>
            <LegalParagraph tight>
              You can revoke this access at any time in your Google account settings. Unlinking
              Google in Lion Reader&apos;s settings also deletes the stored tokens; if Google is
              your only way to sign in, set a password first.
            </LegalParagraph>
            <p className="mt-2">
              <TextLink href="https://policies.google.com/privacy" external className="ui-text-sm">
                View Google&apos;s Privacy Policy &rarr;
              </TextLink>
            </p>
          </LegalSubsection>

          <LegalSubsection title="Discord Bot — Optional">
            <LegalParagraph tight>
              You can optionally link your Discord account to save articles through our Discord bot
              (by reacting to a message or sending a link to the bot). If you enable this feature,
              Discord processes the messages, reactions, and links involved in the interaction as
              part of operating its platform, and we receive the Discord user ID and the links you
              share so we can save them to your account. The bot is not active unless you
              deliberately link it.
            </LegalParagraph>
            <p className="mt-2">
              <TextLink href="https://discord.com/privacy" external className="ui-text-sm">
                View Discord&apos;s Privacy Policy &rarr;
              </TextLink>
            </p>
          </LegalSubsection>

          <LegalSubsection title="Inbound Email (Mailgun)">
            <LegalParagraph tight>
              If you use the email newsletter feature, we use Mailgun to receive emails sent to your
              unique ingest address and forward them to our servers, where they are stored as feed
              entries. Mailgun processes the sender, subject, and content of those emails in order
              to deliver them to us.
            </LegalParagraph>
            <p className="mt-2">
              <TextLink
                href="https://www.mailgun.com/legal/privacy-policy/"
                external
                className="ui-text-sm"
              >
                View Mailgun&apos;s Privacy Policy &rarr;
              </TextLink>
            </p>
          </LegalSubsection>

          <LegalSubsection title="Page Counts (GoatCounter)">
            <LegalParagraph tight>
              We count page views using GoatCounter, a cookie-less analytics service, so we can see
              roughly how many people use Lion Reader and which parts of it get used. This covers
              both our public pages and the app itself.
            </LegalParagraph>
            <LegalParagraph tight>
              <strong>We deliberately do not load GoatCounter&apos;s tracking script.</strong> We
              send the counts ourselves, so we control exactly what is reported: we report the{" "}
              <strong>type of page</strong> you are on, chosen from a short fixed list, and nothing
              user-specific.
            </LegalParagraph>
            <LegalList>
              <li>
                Reading an article reports that an article of a given kind was opened — a feed
                article, a newsletter, or a saved article. <strong>Which</strong> article is not
                part of what we report.
              </li>
              <li>
                Other pages are reported by type — for example &quot;an entry list&quot;, &quot;the
                subscribe page&quot;, or a specific settings page. A list is not identified as a
                particular feed, tag, or subscription.
              </li>
              <li>
                The one exception is our own <PageLink href="/demo">demo</PageLink>: because those
                articles are marketing pages we wrote, not your content, we do record which demo
                article is opened.
              </li>
              <li>
                We do not report page titles, account identifiers, email addresses, or anything else
                tied to your account.
              </li>
            </LegalList>
            <LegalParagraph tight>
              We report the site you arrived from, if any, as just its domain and never the specific
              page, so we can tell where people find us. Your browser separately supplies its user
              agent and language preferences with every web request, from which GoatCounter derives
              your browser, operating system, and language, and it derives an approximate country
              from your IP address — plus, for visitors from the United States, Russia, and China
              only, a broad region such as a US state. We also send your screen width. GoatCounter
              sets no cookies, stores nothing in your browser, and does not track you across sites.
              It keeps only daily and hourly aggregate counts of the above. Your IP address and user
              agent are used transiently (held in memory for up to eight hours) to recognize repeat
              visits and filter bots, and are never written to their database. GoatCounter is
              operated from Ireland with servers in Finland and Germany; deleted data may persist in
              their backups for up to 30 days.
            </LegalParagraph>
            <p className="mt-2">
              <TextLink
                href="https://www.goatcounter.com/help/privacy"
                external
                className="ui-text-sm"
              >
                View GoatCounter&apos;s Privacy Policy &rarr;
              </TextLink>
            </p>
          </LegalSubsection>

          <LegalSubsection title="Object Storage (Fly.io Tigris)">
            <LegalParagraph tight>
              Images embedded in some articles (for example, images from imported Google Docs) are
              stored on Fly.io&apos;s Tigris object storage. These stored images are served from
              Tigris when you view the article.
            </LegalParagraph>
          </LegalSubsection>
        </div>
      </LegalSection>

      <LegalSection title="Cookies and Local Storage">
        <LegalParagraph>
          We use essential cookies for authentication and session management. We also use browser
          storage to save your preferences and cached data:
        </LegalParagraph>
        <LegalList>
          <li>
            <strong>localStorage:</strong> Narration voice settings, reading preferences (show/hide
            read items, sort order), and keyboard shortcut preferences
          </li>
          <li>
            <strong>sessionStorage:</strong> An identifier for the current Sentry session replay, if
            one is being recorded (see Error Tracking and Session Replay above), cleared when you
            close the tab
          </li>
          <li>
            <strong>Origin private file system:</strong> Enhanced narration voices (if you download
            optional high-quality voices using Piper TTS). These voice files are stored locally on
            your device and never sent to our servers.
          </li>
        </LegalList>
        <LegalParagraph>
          We do not use tracking cookies or advertising cookies. Our page counts (see Page Counts
          above) set no cookies and store nothing in your browser.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Data Security">
        <LegalParagraph>
          We implement industry-standard security measures to protect your data:
        </LegalParagraph>
        <LegalList>
          <li>
            <strong>Encrypted connections:</strong> All data transmitted between your device and our
            servers uses HTTPS encryption
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
        </LegalList>
      </LegalSection>

      <LegalSection title="Data Retention">
        <LegalList>
          <li>
            <strong>Account data:</strong> Retained as long as your account is active
          </li>
          <li>
            <strong>Sessions:</strong> Active sessions remain until you log out or they expire
            (configurable expiration). Revoked sessions are deleted immediately.
          </li>
          <li>
            <strong>Feed content:</strong> Shared feed data is retained as long as any user is
            subscribed to that feed. When you unsubscribe, your personal reading state is retained
            (soft delete) so you can resubscribe and maintain your history.
          </li>
          <li>
            <strong>Saved articles:</strong> Retained until you delete them
          </li>
          <li>
            <strong>Narration cache:</strong> Preprocessed narration text is cached indefinitely to
            avoid repeated processing
          </li>
          <li>
            <strong>Logs and metrics:</strong> Application logs, error reports, and session replays
            are retained for 30 days for troubleshooting and performance monitoring
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Your Rights">
        <LegalParagraph>You have the following rights regarding your personal data:</LegalParagraph>
        <LegalList>
          <li>
            <strong>Access:</strong> View all your personal data through your account settings
          </li>
          <li>
            <strong>Export:</strong> Download your feed subscriptions in OPML format for import into
            other RSS readers
          </li>
          <li>
            <strong>Correct:</strong> Update your email address and other account information at any
            time
          </li>
          <li>
            <strong>Revoke access:</strong> Disconnect OAuth accounts (Google, Apple) and revoke
            individual login sessions from your account settings
          </li>
          <li>
            <strong>Control features:</strong> Enable or disable optional features like article
            summarization, AI text processing for narration, and the Discord bot at any time
          </li>
          <li>
            <strong>Delete:</strong> Delete your account and all associated data at any time from
            your{" "}
            <PageLink
              href="/settings/delete-account"
              className="text-accent hover:text-accent-hover font-medium"
            >
              account settings
            </PageLink>
            . Account deletion is permanent and cannot be undone.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Changes to This Policy">
        <LegalParagraph>
          We may update this privacy policy from time to time. We will notify users of any material
          changes by posting the updated policy on this page with a new &quot;Last updated&quot;
          date.
        </LegalParagraph>
      </LegalSection>

      <LegalSection title="Contact">
        <LegalParagraph>
          If you have any questions about this privacy policy or our data practices, please open an
          issue on our GitHub repository.
        </LegalParagraph>
      </LegalSection>
    </LegalPage>
  );
}
