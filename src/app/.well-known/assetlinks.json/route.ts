/**
 * Digital Asset Links for the Android app (GET /.well-known/assetlinks.json).
 *
 * Lets Android verify the app's App Link claim on the OAuth redirect URL, so
 * the authorization code is delivered only to our signed app. See
 * src/server/oauth/app-client.ts.
 */

import { NextResponse } from "next/server";
import { androidAppConfig } from "@/server/config/env";

export function GET() {
  const fingerprints = androidAppConfig.certSha256Fingerprints;
  const statements =
    fingerprints.length === 0
      ? []
      : [
          {
            relation: ["delegate_permission/common.handle_all_urls"],
            target: {
              namespace: "android_app",
              package_name: androidAppConfig.packageName,
              sha256_cert_fingerprints: fingerprints,
            },
          },
        ];
  return NextResponse.json(statements, {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
