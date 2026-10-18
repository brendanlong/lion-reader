/**
 * Extension Save Page
 *
 * Handles the full save flow for the browser extension:
 * 1. Redirects to login if not authenticated
 * 2. Prompts for Google OAuth if needed for Google Docs
 * 3. Saves the article
 * 4. Redirects to callback with API token
 *
 * URL format: /extension/save?url=...&title=...
 * Also accepts POST with html body for authenticated page content.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { validateSession } from "@/server/auth/session";
import { createApiToken, API_TOKEN_SCOPES } from "@/server/auth/api-token";
import { createGoogleAuthUrl } from "@/server/auth/oauth/google";
import { getGoogleDocsGrant, GOOGLE_DOCS_SCOPES } from "@/server/google/tokens";
import { db } from "@/server/db";
import { createCaller } from "@/server/trpc/root";
import { ExtensionSaveClient } from "./client";

interface PageProps {
  searchParams: Promise<{
    url?: string;
    title?: string;
    error?: string;
  }>;
}

export default async function ExtensionSavePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { url, title, error } = params;

  // Validate required parameters
  if (!url) {
    return <ExtensionSaveClient error="No URL provided" />;
  }

  const returnUrl = `/extension/save?url=${encodeURIComponent(url)}${title ? `&title=${encodeURIComponent(title)}` : ""}`;
  const redirectToGoogleDocsAuth = async (): Promise<never> => {
    const authResult = await createGoogleAuthUrl({
      additionalScopes: GOOGLE_DOCS_SCOPES,
      mode: "extension-save",
      returnUrl,
    });
    redirect(authResult.url);
  };

  // Check authentication
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("session")?.value;
  const session = sessionToken ? await validateSession(sessionToken) : null;

  if (!sessionToken || !session) {
    // Not logged in or invalid session - redirect to login with return URL
    redirect(`/login?redirect=${encodeURIComponent(returnUrl)}`);
  }

  // Checked before the Google redirect below, which would otherwise loop when
  // the OAuth callback sends us back with an error
  if (error) {
    return <ExtensionSaveClient error={decodeURIComponent(error)} url={url} />;
  }

  // Check if this is a Google Doc and we need OAuth
  const isGoogleDoc = url.includes("docs.google.com");
  // The Google callback only adds scopes to an already-linked account, so
  // without one, just try the save (public docs need no auth)
  if (isGoogleDoc && (await getGoogleDocsGrant(session.user.id)).status === "missing-scopes") {
    await redirectToGoogleDocsAuth();
  }

  // All auth is complete - save the article
  let saveResult: Awaited<ReturnType<ReturnType<typeof createCaller>["saved"]["save"]>>;
  let needsGoogleReauth = false;

  try {
    const caller = createCaller({
      db,
      session,
      apiToken: null,
      authType: "session",
      scopes: [],
      sessionToken,
      headers: new Headers(),
    });

    saveResult = await caller.saved.save({ url, title: title || undefined });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Failed to save article";

    // Check for Google reauth needed - handle outside try/catch since redirect throws
    if (errorMessage === "NEEDS_GOOGLE_REAUTH") {
      needsGoogleReauth = true;
    } else if (errorMessage === "NEEDS_GOOGLE_SIGNIN") {
      return (
        <ExtensionSaveClient
          error="This is a private Google Doc. To save it, link your Google account in Lion Reader's account settings, then try again."
          url={url}
        />
      );
    } else {
      return <ExtensionSaveClient error={errorMessage} url={url} />;
    }
  }

  // Handle Google reauth redirect outside try/catch (redirect throws)
  if (needsGoogleReauth) {
    await redirectToGoogleDocsAuth();
  }

  // Create an API token for the extension
  const { token } = await createApiToken(
    session.user.id,
    [API_TOKEN_SCOPES.SAVED_WRITE],
    "Browser Extension"
  );

  // Redirect to callback with success (must be outside try/catch as redirect throws)
  // saveResult is guaranteed to be assigned here - if NEEDS_GOOGLE_REAUTH, we redirected above
  const articleTitle = saveResult!.article.title || title || url;
  redirect(
    `/extension/callback?status=success&token=${encodeURIComponent(token)}&title=${encodeURIComponent(articleTitle)}`
  );
}
