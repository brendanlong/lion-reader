/**
 * Shared OAuth helpers used by OAuthSignInButton and LinkedAccounts.
 */

import { trpc } from "@/lib/trpc/client";
import { GoogleIcon, AppleIcon, DiscordIcon } from "@/components/ui/icons";

export type OAuthProvider = "google" | "apple" | "discord";

export const providerNames: Record<OAuthProvider, string> = {
  google: "Google",
  apple: "Apple",
  discord: "Discord",
};

const providerIcons: Record<OAuthProvider, typeof GoogleIcon> = {
  google: GoogleIcon,
  apple: AppleIcon,
  discord: DiscordIcon,
};

export function ProviderIcon({
  provider,
  muted = false,
  className,
}: {
  provider: OAuthProvider;
  muted?: boolean;
  className?: string;
}) {
  const Icon = providerIcons[provider];
  return <Icon muted={muted} className={className} />;
}

interface AuthUrlInput {
  inviteToken?: string;
  /** Where to land after signing in; the server keeps it only if it's same-origin */
  redirect?: string;
}

/**
 * Returns a function that starts a sign-in with the provider and resolves to the
 * URL to send the browser to. Never cached: each URL's state is single-use.
 */
export function useFetchAuthUrl(provider: OAuthProvider) {
  const { client } = trpc.useUtils();
  return (input: AuthUrlInput): Promise<{ url: string }> => {
    switch (provider) {
      case "google":
        return client.auth.googleAuthUrl.query(input);
      case "apple":
        return client.auth.appleAuthUrl.query(input);
      case "discord":
        return client.auth.discordAuthUrl.query(input);
    }
  };
}
