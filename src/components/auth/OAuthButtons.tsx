/**
 * OAuth Buttons Component
 *
 * Renders all available OAuth sign-in buttons with consistent styling.
 * Use this component to keep OAuth provider lists in sync between login and registration.
 */

"use client";

import { GoogleSignInButton } from "./GoogleSignInButton";
import { AppleSignInButton } from "./AppleSignInButton";
import { DiscordSignInButton } from "./DiscordSignInButton";

interface OAuthButtonsProps {
  /** Whether this is for sign-in or sign-up (affects button labels) */
  mode: "signin" | "signup";
  /** Called when an error occurs during OAuth */
  onError: (error: string) => void;
  /** Optional invite token for new user registration */
  inviteToken?: string;
}

/**
 * Renders all OAuth provider buttons.
 *
 * Labels are automatically set based on mode:
 * - signin: "Sign in with {Provider}"
 * - signup: "Continue with {Provider}"
 */
export function OAuthButtons({ mode, onError, inviteToken }: OAuthButtonsProps) {
  const labelPrefix = mode === "signin" ? "Sign in with" : "Continue with";

  return (
    <div className="space-y-3">
      <GoogleSignInButton
        label={`${labelPrefix} Google`}
        onError={onError}
        inviteToken={inviteToken}
      />
      <AppleSignInButton
        label={`${labelPrefix} Apple`}
        onError={onError}
        inviteToken={inviteToken}
      />
      <DiscordSignInButton
        label={`${labelPrefix} Discord`}
        onError={onError}
        inviteToken={inviteToken}
      />
    </div>
  );
}
