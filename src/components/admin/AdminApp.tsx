/**
 * AdminApp Component
 *
 * Main admin application component that handles:
 * - Admin token authentication via localStorage
 * - Login form when no token is present
 * - Tab navigation between admin sections (Invites, Feed Health, Users)
 * - Wrapping authenticated content in AdminTRPCProvider
 *
 * Uses usePathname() for tab routing, matching the pattern used by
 * UnifiedSettingsContent for client-side navigation.
 */

"use client";

import { type FormEvent, type ReactNode, useCallback, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ClientLink } from "@/components/ui/client-link";
import { AdminTRPCProvider } from "@/components/admin/AdminTRPCProvider";
import AdminInvitesContent from "@/components/admin/AdminInvitesContent";
import AdminFeedsContent from "@/components/admin/AdminFeedsContent";
import AdminUsersContent from "@/components/admin/AdminUsersContent";

const ADMIN_TOKEN_KEY = "lion-reader-admin-token";

const adminTabs = [
  { href: "/admin/invites", label: "Invites" },
  { href: "/admin/feeds", label: "Feed Health" },
  { href: "/admin/users", label: "Users" },
];

function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ADMIN_TOKEN_KEY);
}

/**
 * Login form for admin authentication.
 * Stores the admin secret in localStorage on submit.
 */
function AdminLoginForm({ onLogin }: { onLogin: (token: string) => void }) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmed = secret.trim();
      if (!trimmed) {
        setError("Admin secret is required");
        return;
      }
      setError(null);
      localStorage.setItem(ADMIN_TOKEN_KEY, trimmed);
      onLogin(trimmed);
    },
    [secret, onLogin]
  );

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <h1 className="ui-text-lg mb-6 text-center font-bold text-zinc-900 dark:text-zinc-50">
          Admin Login
        </h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            id="admin-secret"
            type="password"
            label="Admin Secret"
            placeholder="Enter admin secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            error={error ?? undefined}
            autoFocus
          />
          <Button type="submit" className="w-full">
            Login
          </Button>
        </form>
      </Card>
    </div>
  );
}

/**
 * Tab navigation bar for admin sections.
 */
function AdminTabNav() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-zinc-200 dark:border-zinc-800">
      <div className="flex gap-1 overflow-x-auto px-4">
        {adminTabs.map((tab) => {
          const isActive = pathname === tab.href;
          return (
            <ClientLink
              key={tab.href}
              href={tab.href}
              className={`ui-text-sm block shrink-0 border-b-2 px-4 py-3 font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? "border-zinc-900 text-zinc-900 dark:border-zinc-50 dark:text-zinc-50"
                  : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200"
              }`}
            >
              {tab.label}
            </ClientLink>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * Authenticated admin shell with header and tab navigation.
 */
function AdminShell({ onLogout, children }: { onLogout: () => void; children: ReactNode }) {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <h1 className="ui-text-lg font-bold text-zinc-900 dark:text-zinc-50">Lion Reader Admin</h1>
        <Button variant="ghost" size="sm" onClick={onLogout}>
          Logout
        </Button>
      </header>

      {/* Tab Navigation */}
      <AdminTabNav />

      {/* Content */}
      <main className="mx-auto max-w-5xl px-4 py-6">
        <AdminContentRouter />
        {children}
      </main>
    </div>
  );
}

/**
 * Routes to the correct content component based on pathname.
 */
function AdminContentRouter() {
  const pathname = usePathname();

  switch (pathname) {
    case "/admin/invites":
      return <AdminInvitesContent />;
    case "/admin/feeds":
      return <AdminFeedsContent />;
    case "/admin/users":
      return <AdminUsersContent />;
    default:
      return <AdminInvitesContent />;
  }
}

interface AdminAppProps {
  children: ReactNode;
}

/**
 * Main admin application component.
 *
 * Manages admin authentication state and provides the admin layout
 * with header, tab navigation, and tRPC provider.
 */
export function AdminApp({ children }: AdminAppProps) {
  const [token, setToken] = useState<string | null>(getStoredToken);

  const handleLogin = useCallback((newToken: string) => {
    setToken(newToken);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    setToken(null);
  }, []);

  if (!token) {
    return <AdminLoginForm onLogin={handleLogin} />;
  }

  return (
    <AdminTRPCProvider token={token}>
      <AdminShell onLogout={handleLogout}>{children}</AdminShell>
    </AdminTRPCProvider>
  );
}
