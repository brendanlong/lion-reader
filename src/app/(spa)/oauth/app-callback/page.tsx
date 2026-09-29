/**
 * The native app's OAuth redirect URL. The installed app claims it as an
 * Android App Link, so a browser only lands here when it doesn't (the app isn't
 * installed, or link verification failed). Deliberately renders nothing from
 * the URL: the query carries an authorization code.
 */

import { AuthLayoutContent } from "@/components/auth/AuthLayoutContent";

export default function AppCallbackPage() {
  return (
    <AuthLayoutContent subtitle="Sign in to the app">
      <p className="ui-text-sm text-muted text-center">
        This link finishes signing in to the Lion Reader app, but it opened in your browser instead.
        Make sure the app is installed and up to date, then start signing in from the app again.
      </p>
    </AuthLayoutContent>
  );
}
