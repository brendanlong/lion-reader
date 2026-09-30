/**
 * Digital Asset Links for the Android apps (GET /.well-known/assetlinks.json).
 *
 * Lets Android verify each app's App Link claim on the OAuth redirect URL, so
 * the authorization code is delivered only to our signed apps. See
 * src/server/oauth/app-client.ts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { androidAppConfig } from "@/server/config/env";
import { logger } from "@/lib/logger";

/** SHA-256 as Android prints it: 32 uppercase hex bytes joined by colons. */
const fingerprintSchema = z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

/**
 * A malformed key would be published and then silently never match, leaving
 * that app unable to finish sign-in; normalize case and log the rest.
 */
function validFingerprints(packageName: string, fingerprints: string[]): string[] {
  return fingerprints
    .map((fingerprint) => fingerprint.toUpperCase())
    .filter((fingerprint) => {
      const ok = fingerprintSchema.safeParse(fingerprint).success;
      if (!ok) {
        logger.error("Ignoring malformed Android signing-key fingerprint", {
          packageName,
          fingerprint,
        });
      }
      return ok;
    });
}

export function GET() {
  const statements = androidAppConfig.packages.flatMap((app) => {
    const fingerprints = validFingerprints(app.packageName, app.certSha256Fingerprints);
    return fingerprints.length === 0
      ? []
      : [
          {
            relation: ["delegate_permission/common.handle_all_urls"],
            target: {
              namespace: "android_app",
              package_name: app.packageName,
              sha256_cert_fingerprints: fingerprints,
            },
          },
        ];
  });
  return NextResponse.json(statements, {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
