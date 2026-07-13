/**
 * AdminApp Component
 *
 * Main admin application component that handles:
 * - Admin authentication via httpOnly cookie session
 * - Login form when no session is present
 * - Tab navigation between admin sections (Invites, Feed Health, Users)
 * - Wrapping authenticated content in AdminTRPCProvider
 *
 * Uses usePathname() for tab routing, matching the pattern used by
 * UnifiedSettingsContent for client-side navigation.
 */

"use client";

import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ClientLink } from "@/components/ui/client-link";
import { AdminTRPCProvider } from "@/components/admin/AdminTRPCProvider";
import AdminOverviewContent from "@/components/admin/AdminOverviewContent";
import AdminInvitesContent from "@/components/admin/AdminInvitesContent";
import AdminFeedsContent from "@/components/admin/AdminFeedsContent";
import AdminUsersContent from "@/components/admin/AdminUsersContent";

const adminTabs = [
  { href: "/admin/overview", label: "Overview" },
  { href: "/admin/invites", label: "Invites" },
  { href: "/admin/feeds", label: "Feed Health" },
  { href: "/admin/users", label: "Users" },
];

/**
 * Login form for admin authentication.
 * Exchanges the admin secret for an httpOnly session cookie via the server.
 */
function AdminLoginForm({ onLogin }: { onLogin: () => void }) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const trimmed = secret.trim();
      if (!trimmed) {
        setError("Admin secret is required");
        return;
      }
      setError(null);
      setIsValidating(true);

      try {
        const res = await fetch("/api/admin/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: trimmed }),
        });

        if (!res.ok) {
          setError("Invalid admin secret");
          return;
        }

        onLogin();
      } catch {
        setError("Failed to connect to server");
      } finally {
        setIsValidating(false);
      }
    },
    [secret, onLogin]
  );

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <h1 className="ui-text-lg text-strong mb-6 text-center font-bold">Admin Login</h1>
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
          <Button type="submit" className="w-full" disabled={isValidating}>
            {isValidating ? "Verifying..." : "Login"}
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
    <nav className="border-edge border-b">
      <div className="flex gap-1 overflow-x-auto px-4">
        {adminTabs.map((tab) => {
          const isActive = pathname === tab.href;
          return (
            <ClientLink
              key={tab.href}
              href={tab.href}
              className={`ui-text-sm block shrink-0 border-b-2 px-4 py-3 font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? "text-strong border-control-selected"
                  : "text-muted hover:text-body border-transparent hover:border-zinc-300 dark:hover:border-zinc-600"
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
      <header className="border-edge flex items-center justify-between border-b px-6 py-4">
        <h1 className="ui-text-lg text-strong font-bold">Lion Reader Admin</h1>
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
    case "/admin/overview":
      return <AdminOverviewContent />;
    case "/admin/invites":
      return <AdminInvitesContent />;
    case "/admin/feeds":
      return <AdminFeedsContent />;
    case "/admin/users":
      return <AdminUsersContent />;
    default:
      return <AdminOverviewContent />;
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
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Check if there's a valid admin session cookie on mount.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/admin/session");
        setIsAuthenticated(res.ok);
      } catch {
        setIsAuthenticated(false);
      }
      setIsLoading(false);
    })();
  }, []);

  const handleLogin = useCallback(() => {
    setIsAuthenticated(true);
  }, []);

  const handleLogout = useCallback(async () => {
    await fetch("/api/admin/session", { method: "DELETE" });
    setIsAuthenticated(false);
  }, []);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="ui-text-sm text-muted">Verifying credentials...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AdminLoginForm onLogin={handleLogin} />;
  }

  return (
    <AdminTRPCProvider>
      <AdminShell onLogout={handleLogout}>{children}</AdminShell>
    </AdminTRPCProvider>
  );
}
