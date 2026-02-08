/**
 * OAuth Consent Page
 *
 * Shows the OAuth consent screen for users to authorize third-party applications.
 * Requires authentication - redirects to login if not authenticated.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { WarningTriangleIcon } from "@/components/ui/icon-button";
import { validateSession } from "@/server/auth/session";
import { resolveClient } from "@/server/oauth/service";
import {
  validateRedirectUri,
  isValidRedirectUriFormat,
  SCOPE_DESCRIPTIONS,
  type OAuthScope,
} from "@/server/oauth/utils";
import { ConsentForm } from "./ConsentForm";

interface ConsentPageProps {
  searchParams: Promise<{
    client_id?: string;
    redirect_uri?: string;
    scope?: string;
    code_challenge?: string;
    state?: string;
    resource?: string;
  }>;
}

export default async function ConsentPage({ searchParams }: ConsentPageProps) {
  const params = await searchParams;
  const { client_id, redirect_uri, scope, code_challenge, state, resource } = params;

  // Validate required parameters
  if (!client_id || !redirect_uri || !code_challenge) {
    return (
      <ConsentLayout>
        <ErrorMessage
          title="Invalid Request"
          message="Missing required OAuth parameters. Please try again."
        />
      </ConsentLayout>
    );
  }

  // Check authentication
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("session")?.value;

  if (!sessionToken) {
    // Redirect to login with return URL
    const returnUrl = `/oauth/consent?${new URLSearchParams(params as Record<string, string>).toString()}`;
    redirect(`/login?redirect=${encodeURIComponent(returnUrl)}`);
  }

  const session = await validateSession(sessionToken);
  if (!session) {
    const returnUrl = `/oauth/consent?${new URLSearchParams(params as Record<string, string>).toString()}`;
    redirect(`/login?redirect=${encodeURIComponent(returnUrl)}`);
  }

  // Validate redirect URI format
  if (!isValidRedirectUriFormat(redirect_uri)) {
    return (
      <ConsentLayout>
        <ErrorMessage title="Invalid Request" message="Invalid redirect URI format." />
      </ConsentLayout>
    );
  }

  // Resolve client
  const client = await resolveClient(client_id);
  if (!client) {
    return (
      <ConsentLayout>
        <ErrorMessage
          title="Unknown Application"
          message="The application requesting access could not be verified."
        />
      </ConsentLayout>
    );
  }

  // Validate redirect URI matches client
  if (!validateRedirectUri(redirect_uri, client.redirectUris)) {
    return (
      <ConsentLayout>
        <ErrorMessage
          title="Invalid Request"
          message="The redirect URI is not registered for this application."
        />
      </ConsentLayout>
    );
  }

  // Parse scopes
  const scopes = scope ? scope.split(" ") : ["mcp"];
  const scopeInfo = scopes.map((s) => ({
    name: s,
    description: SCOPE_DESCRIPTIONS[s as OAuthScope] ?? `Access to ${s}`,
  }));

  return (
    <ConsentLayout>
      <ConsentForm
        clientName={client.name}
        clientId={client_id}
        redirectUri={redirect_uri}
        scopes={scopeInfo}
        scopeString={scopes.join(" ")}
        codeChallenge={code_challenge}
        state={state}
        resource={resource}
      />
    </ConsentLayout>
  );
}

function ConsentLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-zinc-950">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="ui-text-2xl font-bold text-zinc-900 dark:text-zinc-50">Lion Reader</h1>
          <p className="ui-text-sm mt-2 text-zinc-600 dark:text-zinc-400">Authorization Request</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          {children}
        </div>
      </div>
    </div>
  );
}

function ErrorMessage({ title, message }: { title: string; message: string }) {
  return (
    <div className="text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/20">
        <WarningTriangleIcon className="h-6 w-6 text-red-600 dark:text-red-400" />
      </div>
      <h2 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
      <p className="ui-text-sm mt-2 text-zinc-600 dark:text-zinc-400">{message}</p>
    </div>
  );
}
