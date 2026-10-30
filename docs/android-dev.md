# Android development

The app's rules and commands are in `kmp/CLAUDE.md`; releases are under
"Android app releases" in `DEPLOYMENT.md`.

## Debug app and signing

Debug builds are a separate app, `com.lionreader.app.debug`, installable next
to the release one. To sign in to production, a debug build must be signed with
a private dev keystore whose fingerprint is in the server's
`ANDROID_DEBUG_APP_CERT_SHA256` (`SECURITY.md` §6 says which keys may be
listed). Create the keystore once, outside the repo and off shared hosts:

```bash
keytool -genkeypair -v -keystore lionreader-dev.jks -alias dev \
  -keyalg RSA -keysize 4096 -validity 10000
keytool -list -v -keystore lionreader-dev.jks -alias dev   # SHA256 line
```

and point Gradle at it with the properties `lionReaderDevKeystore` (path) and
`lionReaderDevKeystorePassword` (e.g. in `~/.gradle/gradle.properties` on your
own machine, or `ORG_GRADLE_PROJECT_*`). Without them, debug builds use the
default debug key and can sign in only to dev servers.

CI (`.github/workflows/android.yml`) signs its debug build with the same key
(secrets `ANDROID_DEV_KEYSTORE_BASE64` and `ANDROID_DEV_KEYSTORE_PASSWORD`)
and links the APK from a comment on the pull request, so a PR's build (not a
fork's) or master's installs over any other debug build. Anyone who can push a
branch can read those secrets (a workflow change can print them), which is why
the key only covers the debug app.

## Running against a dev server

Start the server with an issuer the phone can reach over USB, e.g.
`PORT=<port> NEXT_PUBLIC_APP_URL=http://localhost:<port> pnpm dev:local`, then
`adb reverse tcp:<port> tcp:<port>` and enter `http://localhost:<port>` on the
sign-in screen (only debug builds accept http). An http redirect can't be an
App Link, so sign-in ends on the server's "opened in your browser" page; for a
server on this machine, its **Open in the debug app** button hands the redirect
over (or `adb shell am start -a com.lionreader.app.DEBUG_SIGN_IN_CALLBACK -d
'<url>'` with the URL from the server's request log). `pnpm db:seed` creates
`test@example.com` / `password123`.
