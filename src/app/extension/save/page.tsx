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
import {
  validateSession,
  createApiToken,
  API_TOKEN_SCOPES,
  createGoogleAuthUrl,
  GOOGLE_DOCS_READONLY_SCOPE,
} from "@/server/auth";
import { db } from "@/server/db";
import { oauthAccounts } from "@/server/db/schema";
import { eq, and } from "drizzle-orm";
import { createCaller } from "@/server/trpc";
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
    return <ExtensionSaveClient status="error" error="No URL provided" />;
  }

  // Check authentication
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("session")?.value;

  if (!sessionToken) {
    // Not logged in - redirect to login with return URL
    const returnUrl = encodeURIComponent(
      `/extension/save?url=${encodeURIComponent(url)}${title ? `&title=${encodeURIComponent(title)}` : ""}`
    );
    redirect(`/login?redirect=${returnUrl}`);
  }

  const session = await validateSession(sessionToken);
  if (!session) {
    // Invalid session - redirect to login
    const returnUrl = encodeURIComponent(
      `/extension/save?url=${encodeURIComponent(url)}${title ? `&title=${encodeURIComponent(title)}` : ""}`
    );
    redirect(`/login?redirect=${returnUrl}`);
  }

  // Check if this is a Google Doc and we need OAuth
  const isGoogleDoc = url.includes("docs.google.com");
  if (isGoogleDoc) {
    // Check if user has Google OAuth with docs scope
    const googleAccount = await db
      .select()
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, session.user.id), eq(oauthAccounts.provider, "google")))
      .limit(1);

    const hasDocsScope = googleAccount[0]?.scopes?.includes(
      "https://www.googleapis.com/auth/documents.readonly"
    );

    if (!hasDocsScope) {
      // Need to request Google Docs scope
      // Generate OAuth URL and redirect to Google with return to this page
      const returnUrl = `/extension/save?url=${encodeURIComponent(url)}${title ? `&title=${encodeURIComponent(title)}` : ""}`;
      const authResult = await createGoogleAuthUrl(
        [GOOGLE_DOCS_READONLY_SCOPE],
        "extension-save",
        returnUrl
      );
      redirect(authResult.url);
    }
  }

  // If there's an error from a previous attempt, show it
  if (error) {
    return (
      <ExtensionSaveClient
        status="error"
        error={decodeURIComponent(error)}
        url={url}
        canRetry={true}
      />
    );
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
    } else {
      return <ExtensionSaveClient status="error" error={errorMessage} url={url} canRetry={true} />;
    }
  }

  // Handle Google reauth redirect outside try/catch (redirect throws)
  if (needsGoogleReauth) {
    const returnUrl = `/extension/save?url=${encodeURIComponent(url)}${title ? `&title=${encodeURIComponent(title)}` : ""}`;
    const authResult = await createGoogleAuthUrl(
      [GOOGLE_DOCS_READONLY_SCOPE],
      "extension-save",
      returnUrl
    );
    redirect(authResult.url);
  }

  // Create an API token for the extension
  const token = await createApiToken(
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
