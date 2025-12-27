/**
 * Auth Layout
 *
 * Centered layout for authentication pages (login, register).
 * Provides a clean, focused UI for auth flows.
 */

"use client";

import type { ReactNode } from "react";
import { TRPCProvider } from "@/lib/trpc/provider";

interface AuthLayoutProps {
  children: ReactNode;
}

export default function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <TRPCProvider>
      <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-zinc-950">
        <div className="w-full max-w-md">
          {/* Logo / Brand */}
          <div className="mb-8 text-center">
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">Lion Reader</h1>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">A modern feed reader</p>
          </div>

          {/* Auth card */}
          <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            {children}
          </div>
        </div>
      </div>
    </TRPCProvider>
  );
}
