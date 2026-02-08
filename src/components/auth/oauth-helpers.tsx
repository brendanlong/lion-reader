/**
 * Shared OAuth helpers used by OAuthSignInButton and LinkedAccounts.
 */

import { trpc } from "@/lib/trpc/client";
import { GoogleIcon, AppleIcon, DiscordIcon } from "@/components/ui/icon-button";

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

/**
 * Hook that returns the auth URL query for a given provider.
 * All three queries are always created (React hook rules), but only
 * the matching one is used.
 */
export function useAuthUrlQuery(provider: OAuthProvider, inviteToken?: string) {
  const google = trpc.auth.googleAuthUrl.useQuery({ inviteToken }, { enabled: false });
  const apple = trpc.auth.appleAuthUrl.useQuery({ inviteToken }, { enabled: false });
  const discord = trpc.auth.discordAuthUrl.useQuery({ inviteToken }, { enabled: false });

  switch (provider) {
    case "google":
      return google;
    case "apple":
      return apple;
    case "discord":
      return discord;
  }
}
