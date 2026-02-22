/**
 * Admin Layout
 *
 * Server component layout for admin pages.
 * Wraps children in AdminApp which handles admin auth
 * client-side via a separate admin token (not session-based).
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminApp } from "@/components/admin/AdminApp";

export const metadata: Metadata = {
  title: "Admin - Lion Reader",
};

interface AdminLayoutProps {
  children: ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      <AdminApp>{children}</AdminApp>
    </div>
  );
}
