/**
 * Where the app's sign-in redirect lands when the app didn't catch it (it isn't
 * installed, or link verification failed). Deliberately renders nothing from
 * the URL: the query carries an authorization code.
 */

import type { ReactNode } from "react";
import { AuthLayoutContent } from "@/components/auth/AuthLayoutContent";

export function AppCallbackContent({ children }: { children?: ReactNode }) {
  return (
    <AuthLayoutContent subtitle="Sign in to the app">
      <p className="ui-text-sm text-muted text-center">
        This link finishes signing in to the Lion Reader app, but it opened in your browser instead.
        Make sure the app is installed and up to date, then start signing in from the app again.
      </p>
      {children}
    </AuthLayoutContent>
  );
}
