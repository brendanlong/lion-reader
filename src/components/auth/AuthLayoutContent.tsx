/**
 * Auth Layout Content
 *
 * The centered, branded card layout shared by the auth pages (login, register,
 * OAuth transitions), signup confirmation, and the OAuth consent screen.
 */

import type { ReactNode } from "react";

interface AuthLayoutContentProps {
  children: ReactNode;
  subtitle?: string;
}

export function AuthLayoutContent({
  children,
  subtitle = "A modern feed reader",
}: AuthLayoutContentProps) {
  return (
    <div className="bg-canvas flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        {/* Logo / Brand */}
        <div className="mb-8 text-center">
          <h1 className="ui-text-2xl text-body font-bold">Lion Reader</h1>
          <p className="ui-text-sm text-muted mt-2">{subtitle}</p>
        </div>

        {/* Auth card */}
        <div className="border-edge bg-surface rounded-lg border p-6 shadow-sm">{children}</div>
      </div>
    </div>
  );
}
