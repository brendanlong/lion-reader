/**
 * What Sentry is allowed to collect automatically. Shared by the server init
 * (`src/server/sentry.ts`) and the browser init (`src/instrumentation-client.ts`)
 * so the two can't drift into different privacy postures.
 */

import type { init } from "@sentry/nextjs";

type SentryOptions = NonNullable<Parameters<typeof init>[0]>;

/**
 * `userInfo: false` stops the SDK attaching user identity to events, the client
 * IP included.
 *
 * This is declared rather than left to the default because the default is not
 * stable in either direction. `userInfo` only resolves to `false` while
 * `dataCollection` is unset — setting that object at all switches the baseline
 * to Sentry's own DEFAULTS, where it is `true` — and SDK v11 removes the
 * `sendDefaultPii` bridge that produces the `false`, so the `true` default then
 * applies unconditionally. Either way IPs would start flowing with no code
 * change and no error.
 *
 * It is only half the guarantee: with no IP from the SDK, Sentry still infers
 * one from the connection unless "Prevent Storing of IP Addresses" is on for the
 * project. That setting has no Terraform representation — see terraform/sentry.tf.
 */
export const SENTRY_DATA_COLLECTION: SentryOptions["dataCollection"] = {
  userInfo: false,
};
