/**
 * OAuth Buttons Component
 *
 * Renders all available OAuth sign-in buttons with consistent styling.
 * Use this component to keep OAuth provider lists in sync between login and registration.
 */

"use client";

import { OAuthSignInButton } from "./OAuthSignInButton";

interface OAuthButtonsProps {
  /** Whether this is for sign-in or sign-up (affects button labels) */
  mode: "signin" | "signup";
  /** Called when an error occurs during OAuth */
  onError: (error: string) => void;
  /** Optional invite token for new user registration */
  inviteToken?: string;
  /** Optional list of allowed providers to show (filters the buttons) */
  allowedProviders?: readonly string[];
}

const providers = ["google", "apple", "discord"] as const;

/**
 * Renders all OAuth provider buttons.
 *
 * Labels are automatically set based on mode:
 * - signin: "Sign in with {Provider}"
 * - signup: "Continue with {Provider}"
 *
 * When allowedProviders is set, only those OAuth providers are shown.
 */
export function OAuthButtons({ mode, onError, inviteToken, allowedProviders }: OAuthButtonsProps) {
  const labelPrefix = mode === "signin" ? "Sign in with" : "Continue with";

  const filteredProviders = allowedProviders
    ? providers.filter((p) => allowedProviders.includes(p))
    : providers;

  return (
    <div className="space-y-3">
      {filteredProviders.map((provider) => (
        <OAuthSignInButton
          key={provider}
          provider={provider}
          label={`${labelPrefix} ${provider.charAt(0).toUpperCase() + provider.slice(1)}`}
          onError={onError}
          inviteToken={inviteToken}
        />
      ))}
    </div>
  );
}
