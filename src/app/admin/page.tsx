/**
 * Admin Root Page
 *
 * Redirects to /admin/invites which is the default admin tab.
 * Uses client-side redirect to avoid SSR.
 */

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { SpinnerIcon } from "@/components/ui/icon-button";

export default function AdminPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin/invites");
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <SpinnerIcon className="h-6 w-6 text-zinc-400" />
    </div>
  );
}
