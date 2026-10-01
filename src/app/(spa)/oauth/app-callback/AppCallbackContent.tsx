/**
 * Where the app's sign-in redirect lands when the browser didn't hand it to the
 * app. Deliberately renders nothing from the URL: the query carries an
 * authorization code.
 */

import type { ReactNode } from "react";
import { AuthLayoutContent } from "@/components/auth/AuthLayoutContent";

export function AppCallbackContent({ children }: { children: ReactNode }) {
  return (
    <AuthLayoutContent subtitle="Sign in to the app">
      <p className="ui-text-sm text-muted text-center">
        One more step: open the app to finish signing in. If nothing happens, make sure the app is
        installed and up to date, then start signing in from the app again.
      </p>
      {children}
    </AuthLayoutContent>
  );
}
