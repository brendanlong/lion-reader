/**
 * Auth Layout Content
 *
 * Client component with the authentication layout UI.
 * Provides a clean, centered layout for auth pages (login, register).
 */

"use client";

import type { ReactNode } from "react";

interface AuthLayoutContentProps {
  children: ReactNode;
}

export function AuthLayoutContent({ children }: AuthLayoutContentProps) {
  return (
    <div className="bg-canvas flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        {/* Logo / Brand */}
        <div className="mb-8 text-center">
          <h1 className="ui-text-2xl text-body font-bold">Lion Reader</h1>
          <p className="ui-text-sm text-muted mt-2">A modern feed reader</p>
        </div>

        {/* Auth card */}
        <div className="border-edge bg-surface rounded-lg border p-6 shadow-sm">{children}</div>
      </div>
    </div>
  );
}
